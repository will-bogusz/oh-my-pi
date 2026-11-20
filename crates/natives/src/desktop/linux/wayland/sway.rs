//! Keeps the user's keyboard while a background accessibility action makes
//! its app open or activate a window (sway).
//!
//! sway focuses every window mapped on the focused workspace
//! (`should_focus` in `sway/tree/view.c`), so a dialog that a background press
//! opens takes the keys the user is typing elsewhere, and a typed Space or
//! Enter answers it. sway runs no scripts, and its one way to keep a new
//! window from taking focus, `no_focus <criteria>`, can be added at runtime
//! but only removed by `reload`. So around each action this watches sway's IPC
//! window events; when a window of the acted-on process, or of a desktop
//! portal backend, takes focus because it appeared or asked for activation
//! during the watch, `[con_id=…] focus` puts the user's window back. The
//! decision is the Hyprland guard's [`Tracker`]; nothing persists.

use std::{
	collections::{HashMap, HashSet},
	io::{self, ErrorKind, Read, Write},
	os::unix::net::UnixStream,
	path::PathBuf,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use parking_lot::Mutex;
use serde::{Deserialize, de::DeserializeOwned};

use super::{
	focus_guard::{Client, Event, POLL, Shared, Tracker, Verdict, Watch},
	peer_pid,
};
use crate::desktop::{
	error::{CoreResult, DesktopError},
	types::DesktopWindowOpened,
};

/// How long one IPC request may take; sway answers in about a millisecond.
const IPC_TIMEOUT: Duration = Duration::from_secs(1);
const MAGIC: &[u8; 6] = b"i3-ipc";
const HEADER: usize = 14;
const RUN_COMMAND: u32 = 0;
const SUBSCRIBE: u32 = 2;
const GET_TREE: u32 = 4;
const WORKSPACE_EVENT: u32 = 0x8000_0000;
const WINDOW_EVENT: u32 = 0x8000_0003;

/// The sway instance serving this session's Wayland socket.
#[derive(Clone, Debug)]
pub(super) struct Sway {
	socket: PathBuf,
}

impl Sway {
	/// sway, when `SWAYSOCK` belongs to the compositor (`compositor_pid`, from
	/// the Wayland socket's peer credentials).
	pub(super) fn detect(compositor_pid: Option<u32>) -> Option<Self> {
		let pid = compositor_pid?;
		let socket = PathBuf::from(std::env::var_os("SWAYSOCK")?);
		let stream = UnixStream::connect(&socket).ok()?;
		(peer_pid(&stream) == Some(pid)).then_some(Self { socket })
	}

	fn connect(&self) -> io::Result<Ipc> {
		let stream = UnixStream::connect(&self.socket)?;
		stream.set_read_timeout(Some(IPC_TIMEOUT))?;
		stream.set_write_timeout(Some(IPC_TIMEOUT))?;
		Ok(Ipc { stream, buf: Vec::new() })
	}
}

/// One connection to sway's IPC socket.
struct Ipc {
	stream: UnixStream,
	/// Bytes read past the last whole message.
	buf:    Vec<u8>,
}

impl Ipc {
	/// Sends a request and reads its reply, skipping events.
	fn json<T: DeserializeOwned>(&mut self, kind: u32, payload: &str) -> CoreResult<T> {
		let failed = |err: String| DesktopError::ax_failed(format!("sway IPC: {err}"));
		self
			.stream
			.write_all(&frame(kind, payload.as_bytes()))
			.map_err(|err| failed(err.to_string()))?;
		loop {
			match self.next() {
				Ok(Some((reply, body, _))) if reply == kind => {
					return serde_json::from_slice(&body).map_err(|err| failed(err.to_string()));
				},
				Ok(_) => {},
				Err(err) => return Err(failed(err.to_string())),
			}
		}
	}

	/// The next whole message, with whether its bytes came with this call's
	/// read (rather than an earlier one); `None` when the read timed out.
	fn next(&mut self) -> io::Result<Option<(u32, Vec<u8>, bool)>> {
		let mut fresh = false;
		loop {
			if let Some((kind, body)) = take_message(&mut self.buf)? {
				return Ok(Some((kind, body, fresh)));
			}
			let mut chunk = [0u8; 16 * 1024];
			match self.stream.read(&mut chunk) {
				Ok(0) => return Err(ErrorKind::UnexpectedEof.into()),
				Ok(n) => {
					self.buf.extend_from_slice(&chunk[..n]);
					fresh = true;
				},
				Err(err) if matches!(err.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
					return Ok(None);
				},
				Err(err) => return Err(err),
			}
		}
	}
}

fn frame(kind: u32, payload: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(HEADER + payload.len());
	out.extend_from_slice(MAGIC);
	out.extend_from_slice(
		&u32::try_from(payload.len())
			.unwrap_or(u32::MAX)
			.to_ne_bytes(),
	);
	out.extend_from_slice(&kind.to_ne_bytes());
	out.extend_from_slice(payload);
	out
}

/// Splits one whole message off the front of `buf`.
fn take_message(buf: &mut Vec<u8>) -> io::Result<Option<(u32, Vec<u8>)>> {
	if buf.len() < HEADER {
		return Ok(None);
	}
	if &buf[..6] != MAGIC {
		return Err(io::Error::new(ErrorKind::InvalidData, "not an i3-ipc message"));
	}
	let word = |at: usize| u32::from_ne_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]]);
	let (len, kind) = (word(6) as usize, word(10));
	if buf.len() < HEADER + len {
		return Ok(None);
	}
	let body = buf[HEADER..HEADER + len].to_vec();
	buf.drain(..HEADER + len);
	Ok(Some((kind, body)))
}

/// A node of sway's tree (`get_tree`), or the container of a window event.
#[derive(Debug, Deserialize)]
struct Node {
	id:                i64,
	/// Present on windows only.
	pid:               Option<i64>,
	app_id:            Option<String>,
	name:              Option<String>,
	#[serde(default)]
	focused:           bool,
	#[serde(default)]
	urgent:            bool,
	window_properties: Option<WindowProperties>,
	#[serde(default)]
	nodes:             Vec<Self>,
	#[serde(default)]
	floating_nodes:    Vec<Self>,
}

#[derive(Debug, Deserialize)]
struct WindowProperties {
	class: Option<String>,
}

impl Node {
	/// The window as the guard sees it, its id as the address.
	fn client(&self) -> Client {
		let class = self
			.app_id
			.clone()
			.or_else(|| {
				self
					.window_properties
					.as_ref()
					.and_then(|p| p.class.clone())
			})
			.unwrap_or_default();
		Client {
			address: self.id.to_string(),
			pid: self.pid.unwrap_or_default(),
			class,
			title: self.name.clone().unwrap_or_default(),
		}
	}

	/// Every window in the tree, and the focused one.
	fn windows(&self, out: &mut Vec<Client>, focused: &mut Option<Client>) {
		if self.pid.is_some_and(|pid| pid > 0) {
			let client = self.client();
			if self.focused {
				*focused = Some(client.clone());
			}
			out.push(client);
		}
		for child in self.nodes.iter().chain(&self.floating_nodes) {
			child.windows(out, focused);
		}
	}
}

#[derive(Debug, Deserialize)]
struct WindowChange {
	change:    String,
	container: Node,
}

#[derive(Debug, Deserialize)]
struct WorkspaceChange {
	change: String,
}

/// The guard's reading of one sway event; a window event's container also
/// goes into `clients`.
fn parse(kind: u32, body: &[u8], clients: &mut HashMap<String, Client>) -> Option<Event> {
	if kind == WORKSPACE_EVENT {
		// Focus moved to another workspace: the user's doing, since a window
		// sway maps takes focus only on the focused workspace.
		let change: WorkspaceChange = serde_json::from_slice(body).ok()?;
		return (change.change == "focus").then_some(Event::Active(None));
	}
	if kind != WINDOW_EVENT {
		return None;
	}
	let WindowChange { change, container } = serde_json::from_slice(body).ok()?;
	let client = container.client();
	let address = client.address.clone();
	clients.insert(address.clone(), client.clone());
	match change.as_str() {
		"new" => Some(Event::Open { address, class: client.class, title: client.title }),
		"focus" => Some(Event::Active(Some(address))),
		"urgent" if container.urgent => Some(Event::Urgent(address)),
		"title" => Some(Event::Title { address, title: client.title }),
		_ => None,
	}
}

#[derive(Deserialize)]
struct Success {
	success: bool,
}

/// Watches sway around background actions; see the module docs.
pub(super) struct SwayGuard {
	sway:    Sway,
	/// Watches whose reports have not all been handed to the caller.
	watches: Vec<Arc<Mutex<Shared>>>,
	/// The latest watch's thread, while it runs; ended by the next watch.
	running: Option<(Arc<AtomicBool>, thread::JoinHandle<()>)>,
}

impl SwayGuard {
	pub(super) const fn new(sway: Sway) -> Self {
		Self { sway, watches: Vec::new(), running: None }
	}

	/// What windows actions opened did to focus, each outcome once.
	pub(super) fn take(&mut self) -> Vec<DesktopWindowOpened> {
		let mut out = Vec::new();
		self.watches.retain(|watch| {
			let mut shared = watch.lock();
			let Shared { report, given, done } = &mut *shared;
			for (address, entry) in report.iter() {
				if given.insert((address.clone(), entry.focus)) {
					out.push(entry.clone());
				}
			}
			!*done
		});
		out
	}

	/// Runs `action` on process `pid` under a watch, like the Hyprland guard;
	/// unwatched when the user's focused window is the target's or sway
	/// cannot be read.
	pub(super) fn run<T>(&mut self, pid: u32, action: impl FnOnce() -> T) -> T {
		let Some(watch) = self.arm(pid) else {
			return action();
		};
		let result = action();
		watch.finish();
		result
	}

	fn arm(&mut self, pid: u32) -> Option<Watch> {
		if let Some((stop, thread)) = self.running.take() {
			stop.store(true, Ordering::Release);
			let _ = thread.join();
		}
		let mut command = self.sway.connect().ok()?;
		let tree: Node = command.json(GET_TREE, "").ok()?;
		let (mut windows, mut user) = (Vec::new(), None);
		tree.windows(&mut windows, &mut user);
		let user = user?;
		if user.pid <= 0 || user.pid == i64::from(pid) {
			return None;
		}
		let known: HashSet<String> = windows.iter().map(|w| w.address.clone()).collect();
		let mut events = self.sway.connect().ok()?;
		let subscribed: Success = events.json(SUBSCRIBE, r#"["window","workspace"]"#).ok()?;
		if !subscribed.success {
			return None;
		}
		events.stream.set_read_timeout(Some(POLL)).ok()?;
		let started = Instant::now();
		let ends = Arc::new(AtomicU64::new(u64::MAX));
		let stop = Arc::new(AtomicBool::new(false));
		let shared = Arc::new(Mutex::new(Shared::default()));
		let watcher = Watcher {
			hand_back: format!("[con_id={}] focus", user.address),
			command,
			clients: windows
				.into_iter()
				.map(|w| (w.address.clone(), w))
				.collect(),
			tracker: Tracker::new(user, pid, known, started),
			started,
			ends: Arc::clone(&ends),
			stop: Arc::clone(&stop),
			shared: Arc::clone(&shared),
		};
		let thread = thread::Builder::new()
			.name("sway-focus-guard".into())
			.spawn(move || watcher.watch(events))
			.ok()?;
		self.running = Some((stop, thread));
		self.watches.push(Arc::clone(&shared));
		Some(Watch { ends, started, shared })
	}
}

struct Watcher {
	/// Request connection, open before the action so a hand-back costs one
	/// write and one reply.
	command:   Ipc,
	/// The command that focuses the user's window.
	hand_back: String,
	clients:   HashMap<String, Client>,
	tracker:   Tracker,
	started:   Instant,
	ends:      Arc<AtomicU64>,
	stop:      Arc<AtomicBool>,
	shared:    Arc<Mutex<Shared>>,
}

impl Watcher {
	fn over(&self) -> bool {
		self.stop.load(Ordering::Acquire)
			|| u64::try_from(self.started.elapsed().as_nanos()).unwrap_or(u64::MAX)
				>= self.ends.load(Ordering::Acquire)
	}

	fn watch(mut self, mut events: Ipc) {
		// When the bytes of the message being read arrived (see the Hyprland
		// watcher): a message already whole in the buffer came with the read
		// that filled it.
		let mut read_at = Instant::now();
		while !self.over() {
			let (kind, body, fresh) = match events.next() {
				Ok(Some(message)) => message,
				Ok(None) => continue,
				Err(_) => break,
			};
			if fresh {
				read_at = Instant::now();
			}
			let Some(event) = parse(kind, &body, &mut self.clients) else {
				continue;
			};
			let (clients, command) = (&mut self.clients, &mut self.command);
			let mut client = |address: &str| {
				if !clients.contains_key(address) {
					let tree: Node = command.json(GET_TREE, "").ok()?;
					let (mut windows, mut focused) = (Vec::new(), None);
					tree.windows(&mut windows, &mut focused);
					clients.extend(windows.into_iter().map(|w| (w.address.clone(), w)));
				}
				clients.get(address).cloned()
			};
			if self.tracker.event(&event, read_at, &mut client) == Verdict::HandBack {
				let _ = self
					.command
					.json::<Vec<Success>>(RUN_COMMAND, &self.hand_back);
			}
			self.shared.lock().report = self.tracker.report();
		}
		let mut shared = self.shared.lock();
		shared.report = self.tracker.report();
		shared.done = true;
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::desktop::types::DesktopWindowFocus;

	fn window(id: i64, pid: i64, app_id: &str, name: &str) -> String {
		format!(
			r#"{{"id":{id},"type":"floating_con","pid":{pid},"app_id":"{app_id}","name":"{name}","urgent":false}}"#
		)
	}

	#[test]
	fn messages_split_on_their_frames_however_the_bytes_arrive() {
		let mut wire = frame(WINDOW_EVENT, b"{\"a\":1}");
		wire.extend(frame(RUN_COMMAND, b"[]"));
		let mut buf = wire[..10].to_vec();
		assert_eq!(take_message(&mut buf).unwrap(), None);
		buf.extend_from_slice(&wire[10..]);
		assert_eq!(take_message(&mut buf).unwrap(), Some((WINDOW_EVENT, b"{\"a\":1}".to_vec())));
		assert_eq!(take_message(&mut buf).unwrap(), Some((RUN_COMMAND, b"[]".to_vec())));
		assert!(buf.is_empty());
		assert!(take_message(&mut b"not-ipc-at-all".to_vec()).is_err());
	}

	#[test]
	fn the_tree_gives_every_window_and_the_focused_one() {
		let tree = format!(
			r#"{{"id":1,"type":"root","nodes":[{{"id":3,"type":"workspace","nodes":[
				{{"id":5,"type":"con","pid":10,"app_id":"typist","name":"foot","focused":true}},
				{{"id":7,"type":"con","pid":20,"app_id":null,"name":"X","window_properties":{{"class":"Xapp"}}}}],
				"floating_nodes":[{}]}}]}}"#,
			window(9, 20, "tdlg.py", "Allow?")
		);
		let tree: Node = serde_json::from_str(&tree).unwrap();
		let (mut windows, mut focused) = (Vec::new(), None);
		tree.windows(&mut windows, &mut focused);
		let ids: Vec<_> = windows
			.iter()
			.map(|w| (w.address.as_str(), w.class.as_str()))
			.collect();
		assert_eq!(ids, [("5", "typist"), ("7", "Xapp"), ("9", "tdlg.py")]);
		assert_eq!(focused.map(|f| f.address), Some("5".to_owned()));
	}

	/// sway posts `new` then `focus` for a dialog; the guard hands back, and
	/// the user's own later pick is left alone.
	#[test]
	fn a_dialog_sway_focuses_is_handed_back_and_the_users_pick_is_not() {
		let t0 = Instant::now();
		let user = Client {
			address: "5".into(),
			pid:     10,
			class:   "typist".into(),
			title:   "foot".into(),
		};
		let known = ["5", "7"].map(str::to_owned).into();
		let mut tracker = Tracker::new(user, 20, known, t0);
		let mut clients = HashMap::new();
		let mut feed = |tracker: &mut Tracker, ms: u64, kind: u32, body: String| {
			let event = parse(kind, body.as_bytes(), &mut clients).expect("a guarded event");
			let snapshot = clients.clone();
			let mut lookup = |address: &str| snapshot.get(address).cloned();
			tracker.event(&event, t0 + Duration::from_millis(ms), &mut lookup)
		};
		let change = |change: &str, container: String| {
			format!(r#"{{"change":"{change}","container":{container}}}"#)
		};
		let dialog = window(13, 20, "tdlg.py", "Allow?");
		assert_eq!(
			feed(&mut tracker, 50, WINDOW_EVENT, change("new", dialog.clone())),
			Verdict::Nothing
		);
		assert_eq!(
			feed(&mut tracker, 50, WINDOW_EVENT, change("focus", dialog.clone())),
			Verdict::HandBack
		);
		let typist = window(5, 10, "typist", "foot");
		assert_eq!(feed(&mut tracker, 51, WINDOW_EVENT, change("focus", typist)), Verdict::Nothing);
		// The user clicks the dialog two seconds later: their choice.
		assert_eq!(feed(&mut tracker, 2050, WINDOW_EVENT, change("focus", dialog)), Verdict::Nothing);
		let report: Vec<_> = tracker
			.report()
			.into_iter()
			.map(|(_, r)| (r.title, r.focus, r.held_ms))
			.collect();
		assert_eq!(report, [("Allow?".to_owned(), DesktopWindowFocus::HandedBack, Some(1))]);
		// A workspace switch is a pick too.
		assert_eq!(
			parse(WORKSPACE_EVENT, br#"{"change":"focus"}"#, &mut HashMap::new()),
			Some(Event::Active(None))
		);
		assert_eq!(parse(WORKSPACE_EVENT, br#"{"change":"init"}"#, &mut HashMap::new()), None);
	}
}
