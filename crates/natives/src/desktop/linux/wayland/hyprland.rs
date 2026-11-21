//! Where Hyprland shows each window, read over its IPC socket (`hyprctl -j`).
//! A native Wayland client cannot learn where the compositor put it, so over
//! AT-SPI its window reads `0,0`. Nothing ties an AT-SPI window to a Hyprland
//! window but its process, so only an app with one window on each side is
//! placed. Requests only read; nothing is kept from one to the next, and any
//! failure leaves the caller with what AT-SPI said.

use std::{
	io::{self, Read, Write},
	os::{
		fd::{FromRawFd, OwnedFd},
		unix::{ffi::OsStrExt, net::UnixStream},
	},
	path::{Path, PathBuf},
	time::{Duration, Instant},
};

use serde::{Deserialize, de::DeserializeOwned};

use super::{peer_pid, wayland_socket};
use crate::desktop::{
	error::{CoreResult, DesktopError},
	linux::ax::AtSpiWindow,
	types::DesktopWindow,
};

/// How long reading Hyprland may add to one call, connection to last byte;
/// Hyprland answers in about a millisecond.
pub(super) const IPC_TIMEOUT: Duration = Duration::from_secs(1);
/// The largest reply read; a `j/clients` of a hundred windows is about 100 KiB.
const MAX_REPLY: usize = 16 * 1024 * 1024;

/// A workspace as Hyprland identifies it: its `id`, or, from 0.57 on, where a
/// named or special workspace has none, its `address`. The displayed `name`
/// identifies nothing: a rename changes it and two workspaces can share it.
#[derive(Debug, Default, Deserialize)]
struct Workspace {
	id:      Option<i64>,
	address: Option<String>,
}

impl Workspace {
	/// `None` for no workspace: `-1` holds a closing window, and a monitor
	/// with no special workspace open reports id `0` (0.56) or an empty
	/// address.
	fn key(&self) -> Option<String> {
		match (self.id, &self.address) {
			(Some(id), _) => (id != 0 && id != -1).then(|| id.to_string()),
			(None, address) => address.clone().filter(|address| !address.is_empty()),
		}
	}
}

/// The keys read from each `j/clients` entry; a reply missing one is refused.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Client {
	mapped:    bool,
	/// Drawn: not hidden (a swallowed terminal, an inactive group tab) and
	/// not transparent. Read for captures only.
	#[serde(default)]
	visible:   bool,
	at:        [i32; 2],
	size:      [u32; 2],
	workspace: Workspace,
	pid:       i64,
	/// The window for the compositor's life; its `address` can be reused by
	/// the next window. Read for captures only.
	#[serde(default)]
	stable_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Monitor {
	x:                 i32,
	y:                 i32,
	/// In pixels; `scale` gives the logical size.
	width:             u32,
	height:            u32,
	scale:             f64,
	active_workspace:  Workspace,
	special_workspace: Workspace,
}

impl Monitor {
	/// Whether this monitor is the logical rectangle `rect` and shows
	/// workspace `key`.
	fn shows(&self, rect: (i32, i32, u32, u32), key: &str) -> bool {
		let logical = |pixels: u32| (f64::from(pixels) / self.scale).round() as u32;
		(self.x, self.y, logical(self.width), logical(self.height)) == rect
			&& [&self.active_workspace, &self.special_workspace]
				.iter()
				.any(|workspace| workspace.key().as_deref() == Some(key))
	}
}

/// Hyprland's state as one read saw it.
pub(super) struct Snapshot {
	clients:  Vec<Client>,
	monitors: Vec<Monitor>,
}

/// The request socket of the Hyprland serving this session's Wayland socket.
pub(super) struct Session {
	socket:     PathBuf,
	compositor: u32,
}

/// Connects without waiting: a socket whose server stopped accepting, with
/// its queue full, refuses at once instead of blocking the call.
fn connect(path: &Path) -> io::Result<UnixStream> {
	let bytes = path.as_os_str().as_bytes();
	// SAFETY: `sockaddr_un` is plain old data; all zeroes is a valid value.
	let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
	if bytes.len() >= address.sun_path.len() {
		return Err(io::Error::from(io::ErrorKind::InvalidInput));
	}
	address.sun_family = libc::AF_UNIX as libc::sa_family_t;
	for (to, from) in address.sun_path.iter_mut().zip(bytes) {
		*to = *from as libc::c_char;
	}
	// SAFETY: plain socket creation; the descriptor is owned below.
	let fd = unsafe {
		libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC, 0)
	};
	if fd < 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `fd` is a fresh descriptor nothing else owns.
	let stream = UnixStream::from(unsafe { OwnedFd::from_raw_fd(fd) });
	let length = (std::mem::size_of::<libc::sa_family_t>() + bytes.len()) as libc::socklen_t;
	// SAFETY: `address` is a live, initialized `sockaddr_un` of `length` bytes.
	if unsafe { libc::connect(fd, (&raw const address).cast(), length) } != 0 {
		return Err(io::Error::last_os_error());
	}
	stream.set_nonblocking(false)?;
	Ok(stream)
}

/// A JSON list whose every entry is an object with `T`'s keys; a list of
/// arrays, which serde would read positionally, is refused.
fn objects<T: DeserializeOwned>(reply: &[u8]) -> serde_json::Result<Vec<T>> {
	let rows: Vec<serde_json::Map<String, serde_json::Value>> = serde_json::from_slice(reply)?;
	rows
		.into_iter()
		.map(|row| serde_json::from_value(serde_json::Value::Object(row)))
		.collect()
}

/// Whether this session names a Hyprland instance; nothing is connected.
pub(super) fn running() -> bool {
	std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some()
}

impl Session {
	/// Hyprland's socket for this session, found again at every read; `None`
	/// outside Hyprland or when the Wayland socket does not accept at once.
	pub(super) fn current() -> Option<Self> {
		let signature = std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE")?;
		let socket = PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR")?)
			.join("hypr")
			.join(signature)
			.join(".socket.sock");
		let compositor = peer_pid(&connect(&wayland_socket()?).ok()?)?;
		Some(Self { socket, compositor })
	}

	/// One request, answered by the compositor itself before `deadline`.
	fn request<T: DeserializeOwned>(&self, command: &str, deadline: Instant) -> CoreResult<Vec<T>> {
		let failed =
			|err: io::Error| DesktopError::ax_failed(format!("Hyprland IPC {command}: {err}"));
		let left = || {
			let left = deadline.saturating_duration_since(Instant::now());
			if left.is_zero() {
				Err(failed(io::ErrorKind::TimedOut.into()))
			} else {
				Ok(left)
			}
		};
		left()?;
		let mut stream = connect(&self.socket).map_err(failed)?;
		if peer_pid(&stream) != Some(self.compositor) {
			return Err(failed(io::ErrorKind::PermissionDenied.into()));
		}
		stream.set_write_timeout(Some(left()?)).map_err(failed)?;
		stream.write_all(command.as_bytes()).map_err(failed)?;
		let mut reply = Vec::new();
		let mut chunk = [0; 16 * 1024];
		loop {
			stream.set_read_timeout(Some(left()?)).map_err(failed)?;
			match stream.read(&mut chunk).map_err(failed)? {
				0 => break,
				read if reply.len() + read > MAX_REPLY => {
					return Err(failed(io::ErrorKind::FileTooLarge.into()));
				},
				read => reply.extend_from_slice(&chunk[..read]),
			}
		}
		objects(&reply).map_err(|err| failed(err.into()))
	}

	/// Every client, mapped or not, read before `deadline`.
	pub(super) fn clients(&self, deadline: Instant) -> CoreResult<Vec<Client>> {
		self.request("j/clients", deadline)
	}

	/// Clients and monitors, read within `budget`, which this spends: the
	/// reads on both sides of one capture share one budget.
	pub(super) fn snapshot(&self, budget: &mut Duration) -> CoreResult<Snapshot> {
		let start = Instant::now();
		let deadline = start + *budget;
		let read = self.request("j/clients", deadline).and_then(|clients| {
			Ok(Snapshot { clients, monitors: self.request("j/monitors", deadline)? })
		});
		*budget = budget.saturating_sub(start.elapsed());
		read
	}
}

/// The client showing AT-SPI window `window`, when its app has exactly one
/// window on each side: one in `windows` (AT-SPI's) and one Hyprland client,
/// mapped. Titles and sizes are not compared: an app can give two windows the
/// same title, or swap them, so no other app is placed.
pub(super) fn client_for<'a>(
	clients: &'a [Client],
	windows: &[AtSpiWindow],
	window: &DesktopWindow,
) -> Option<&'a Client> {
	let pid = window.pid?;
	if windows
		.iter()
		.filter(|other| other.window.pid == Some(pid))
		.count()
		!= 1
	{
		return None;
	}
	let mut own = clients.iter().filter(|client| client.pid == i64::from(pid));
	let client = own.next()?;
	(own.next().is_none() && client.mapped).then_some(client)
}

/// AT-SPI's windows as listed: each whose toolkit gives no position takes
/// the place and size of its app's one client (`client_for`); every other
/// field, and every other window, stays AT-SPI's.
pub(super) fn listed(windows: Vec<AtSpiWindow>, clients: &[Client]) -> Vec<DesktopWindow> {
	let places: Vec<_> = windows
		.iter()
		.map(|entry| {
			let client = client_for(clients, &windows, &entry.window)?;
			(!entry.position_known).then_some((client.at, client.size))
		})
		.collect();
	windows
		.into_iter()
		.zip(places)
		.map(|(AtSpiWindow { mut window, .. }, place)| {
			if let Some(([x, y], [width, height])) = place {
				(window.x, window.y, window.width, window.height) = (x, y, width, height);
			}
			window
		})
		.collect()
}

/// Where a capture of `window` from the portal monitor `portal` (its logical
/// rectangle) is cut, `at` and `size`: the app's one client, drawn, on a
/// workspace that monitor shows, the same window (`stableId`) in the same
/// place in both reads, each taken with what AT-SPI listed then. `None` when
/// a read cannot say.
pub(super) fn agreed(
	before: (&Snapshot, &[AtSpiWindow]),
	after: (&Snapshot, &[AtSpiWindow]),
	window: &DesktopWindow,
	portal: (i32, i32, u32, u32),
) -> Option<([i32; 2], [u32; 2])> {
	let shown = before.0.shown(before.1, window, portal)?;
	(after.0.shown(after.1, window, portal)? == shown).then_some((shown.2, shown.3))
}

impl Snapshot {
	fn shown(
		&self,
		windows: &[AtSpiWindow],
		window: &DesktopWindow,
		portal: (i32, i32, u32, u32),
	) -> Option<(&str, String, [i32; 2], [u32; 2])> {
		let client = client_for(&self.clients, windows, window)
			.filter(|client| client.visible && !client.stable_id.is_empty())?;
		let workspace = client.workspace.key()?;
		self
			.monitors
			.iter()
			.any(|monitor| monitor.shows(portal, &workspace))
			.then_some((client.stable_id.as_str(), workspace, client.at, client.size))
	}
}

#[cfg(test)]
mod tests {
	use std::os::{fd::AsRawFd, unix::net::UnixListener};

	use super::*;

	/// `j/clients` from Hyprland 0.56.2, trimmed: a GTK window and a terminal
	/// on workspace 1, Files on workspace 2, a calculator on a special
	/// workspace, and a window being closed.
	const CLIENTS: &str = r#"[
		{"address":"0x5501","mapped":true,"hidden":false,"visible":true,"at":[12,38],"size":[621,750],
		 "workspace":{"id":1,"name":"1"},"class":"tdlg.py","title":"TDLG","pid":5104,"stableId":"11"},
		{"address":"0x5502","mapped":true,"hidden":false,"visible":true,"at":[647,38],"size":[621,750],
		 "workspace":{"id":1,"name":"1"},"class":"foot","title":"foot","pid":4920,"stableId":"12"},
		{"address":"0x5503","mapped":true,"hidden":false,"visible":true,"at":[12,38],"size":[1256,750],
		 "workspace":{"id":2,"name":"2"},"class":"org.gnome.Nautilus","title":"Home","pid":6001,"stableId":"13"},
		{"address":"0x5504","mapped":true,"hidden":false,"visible":true,"at":[112,88],"size":[1056,650],
		 "workspace":{"id":-98,"name":"special:magic"},"class":"calc","title":"Calc","pid":6003,"stableId":"14"},
		{"address":"0x5507","mapped":false,"hidden":true,"visible":false,"at":[0,0],"size":[0,0],
		 "workspace":{"id":-1,"name":""},"class":"","title":"","pid":-1,"stableId":"15"}
	]"#;

	/// `j/monitors` from 0.56.2, trimmed: a 1280x800 monitor showing workspace
	/// 1, no special one.
	const MONITORS: &str = r#"[{"id":0,"name":"Virtual-1","x":0,"y":0,"width":1280,"height":800,
		"scale":1.0,"activeWorkspace":{"id":1,"name":"1"},"specialWorkspace":{"id":0,"name":""}}]"#;

	/// The portal stream of that monitor, as a logical rectangle.
	const PORTAL: (i32, i32, u32, u32) = (0, 0, 1280, 800);

	fn serve(socket: PathBuf, replies: Vec<(&'static str, &'static str)>) -> Session {
		let listener = UnixListener::bind(&socket).unwrap();
		std::thread::spawn(move || {
			for (command, reply) in replies {
				let (mut stream, _) = listener.accept().unwrap();
				let mut request = [0; 64];
				let read = stream.read(&mut request).unwrap();
				assert_eq!(&request[..read], command.as_bytes());
				stream.write_all(reply.as_bytes()).unwrap();
			}
		});
		Session { socket, compositor: std::process::id() }
	}

	/// Long enough that no test depends on when its server thread runs.
	fn unhurried() -> Instant {
		Instant::now() + Duration::from_secs(60)
	}

	fn parse<T: DeserializeOwned>(json: &str) -> Vec<T> {
		objects(json.as_bytes()).unwrap()
	}

	fn atspi(pid: u32, title: &str, position_known: bool) -> AtSpiWindow {
		AtSpiWindow {
			window: DesktopWindow {
				id:      format!("atspi:{pid}:{title}"),
				title:   title.into(),
				app:     "app".into(),
				pid:     Some(pid),
				x:       0,
				y:       0,
				width:   600,
				height:  400,
				focused: false,
			},
			position_known,
		}
	}

	fn snapshot(clients: &str) -> Snapshot {
		Snapshot { clients: parse(clients), monitors: parse(MONITORS) }
	}

	#[test]
	fn clients_and_monitors_are_read_one_request_each_within_one_budget() {
		let dir = tempfile::tempdir().unwrap();
		let hyprland = serve(dir.path().join(".socket.sock"), vec![
			("j/clients", CLIENTS),
			("j/monitors", MONITORS),
		]);
		let mut budget = Duration::from_secs(60);
		let read = hyprland.snapshot(&mut budget).unwrap();
		assert!(budget < Duration::from_secs(60));
		assert_eq!(read.clients.len(), 5);
		assert_eq!(read.monitors.len(), 1);

		// A compositor that accepts and never answers: the first read spends
		// the budget, and the read after the frame gets only what is left.
		let socket = dir.path().join("silent.sock");
		let _listener = UnixListener::bind(&socket).unwrap();
		let silent = Session { socket, compositor: std::process::id() };
		let mut budget = Duration::from_millis(200);
		assert!(silent.snapshot(&mut budget).is_err());
		assert!(budget < Duration::from_millis(10), "{budget:?}");
		let start = Instant::now();
		assert!(silent.snapshot(&mut budget).is_err());
		assert!(start.elapsed() < Duration::from_millis(10), "{:?}", start.elapsed());
	}

	#[test]
	fn a_reply_that_is_not_a_whole_object_list_is_refused() {
		const ROW: &str =
			r#"{"mapped":true,"at":[12,38],"size":[621,750],"workspace":{"id":1},"pid":5104}"#;
		for reply in [
			String::new(),
			"unknown request".to_owned(),
			"{}".to_owned(),
			// Cut off mid-list.
			format!("[{ROW},"),
			// A key missing.
			format!("[{}]", ROW.replace(r#","pid":5104"#, "")),
			// A negative size.
			format!("[{}]", ROW.replace("[621,750]", "[-1,750]")),
			// A row in positional form after a whole one.
			format!(r#"[{ROW},[true,[12,38],[621,750],{{"id":1}},5104]]"#),
		] {
			assert!(objects::<Client>(reply.as_bytes()).is_err(), "{reply}");
		}
		assert_eq!(
			objects::<Client>(format!("[{ROW}]").as_bytes())
				.unwrap()
				.len(),
			1
		);
	}

	#[test]
	fn a_socket_nobody_accepts_on_refuses_instead_of_blocking() {
		let dir = tempfile::tempdir().unwrap();
		let socket = dir.path().join(".socket.sock");
		let listener = UnixListener::bind(&socket).unwrap();
		// SAFETY: listening again only shrinks the queue of a live socket.
		assert_eq!(unsafe { libc::listen(listener.as_raw_fd(), 0) }, 0);
		let mut held = Vec::new();
		let refused = loop {
			match connect(&socket) {
				Ok(stream) => held.push(stream),
				Err(error) => break error,
			}
			assert!(held.len() < 16, "the accept queue never filled");
		};
		assert_eq!(refused.kind(), io::ErrorKind::WouldBlock);
	}

	#[test]
	fn a_compositor_that_does_not_answer_is_given_up_on_at_the_deadline() {
		let dir = tempfile::tempdir().unwrap();
		let socket = dir.path().join(".socket.sock");
		let listener = UnixListener::bind(&socket).unwrap();
		let hyprland = Session { socket, compositor: std::process::id() };
		// Accepted by the kernel, never answered.
		assert!(
			hyprland
				.request::<Client>("j/clients", Instant::now() + Duration::from_millis(50))
				.is_err()
		);
		drop(listener);
	}

	#[test]
	fn a_socket_another_process_serves_is_sent_nothing() {
		let dir = tempfile::tempdir().unwrap();
		let socket = dir.path().join(".socket.sock");
		let listener = UnixListener::bind(&socket).unwrap();
		let hyprland = Session { socket, compositor: std::process::id() + 1 };
		assert!(
			hyprland
				.request::<Client>("j/clients", unhurried())
				.is_err()
		);
		let (mut stream, _) = listener.accept().unwrap();
		assert_eq!(stream.read(&mut [0; 64]).unwrap(), 0);
	}

	#[test]
	fn only_an_app_with_one_window_on_each_side_is_placed() {
		let clients: Vec<Client> = parse(CLIENTS);
		let tdlg = atspi(5104, "TDLG", false);
		let place = |windows: &[AtSpiWindow], window: &AtSpiWindow| {
			client_for(&clients, windows, &window.window).map(|client| client.at)
		};
		assert_eq!(place(&[atspi(5104, "TDLG", false)], &tdlg), Some([12, 38]));
		// Titles are not compared: the one window is the one client.
		let renamed = atspi(5104, "Untitled", false);
		assert_eq!(place(&[atspi(5104, "Untitled", false)], &renamed), Some([12, 38]));
		// A second accessible window of the app: neither is placed.
		let dialog = atspi(5104, "Dialog", false);
		let both = [atspi(5104, "TDLG", false), atspi(5104, "Dialog", false)];
		assert_eq!(place(&both, &tdlg), None);
		assert_eq!(place(&both, &dialog), None);
		// A second Hyprland window of the app: neither is placed.
		let mut two: Vec<Client> = parse(CLIENTS);
		two.extend(parse::<Client>(
			&CLIENTS
				.replace("[647,38]", "[700,38]")
				.replace("4920", "5104"),
		));
		assert!(client_for(&two, &[atspi(5104, "TDLG", false)], &tdlg.window).is_none());
		// No client, or an unmapped one.
		let closing = atspi(4242, "Gone", false);
		assert_eq!(place(&[atspi(4242, "Gone", false)], &closing), None);
		let unmapped: Vec<Client> = parse(&CLIENTS.replace(r#""mapped":true"#, r#""mapped":false"#));
		assert!(client_for(&unmapped, &[atspi(5104, "TDLG", false)], &tdlg.window).is_none());
	}

	#[test]
	fn only_windows_without_a_position_are_listed_where_hyprland_shows_them() {
		let windows = || {
			vec![
				atspi(5104, "TDLG", false),
				// A toolkit that knows its position keeps it.
				atspi(4920, "foot", true),
				// An app with two windows stays as AT-SPI lists it.
				atspi(6001, "Home", false),
				atspi(6001, "Preferences", false),
			]
		};
		let rects = |listed: Vec<DesktopWindow>| {
			listed
				.into_iter()
				.map(|window| (window.x, window.y, window.width, window.height))
				.collect::<Vec<_>>()
		};
		assert_eq!(rects(listed(windows(), &parse(CLIENTS))), [
			(12, 38, 621, 750),
			(0, 0, 600, 400),
			(0, 0, 600, 400),
			(0, 0, 600, 400),
		]);
		assert_eq!(rects(listed(windows(), &[])), [(0, 0, 600, 400); 4]);
	}

	#[test]
	fn workspaces_are_told_apart_by_id_or_address_never_by_name() {
		let key = |json: &str| serde_json::from_str::<Workspace>(json).unwrap().key();
		assert_eq!(key(r#"{"id":1,"name":"1"}"#), Some("1".into()));
		assert_eq!(key(r#"{"id":-98,"name":"special:magic"}"#), Some("-98".into()));
		// 0.57: a named workspace has an address and no id.
		assert_eq!(key(r#"{"address":"0xa1","name":"mail"}"#), Some("0xa1".into()));
		assert_eq!(key(r#"{"address":"0xa2","name":"mail"}"#), Some("0xa2".into()));
		// No workspace: a closing window, a monitor without a special one.
		assert_eq!(key(r#"{"id":-1,"name":""}"#), None);
		assert_eq!(key(r#"{"id":0,"name":""}"#), None);
		assert_eq!(key(r#"{"address":"","name":""}"#), None);
	}

	#[test]
	fn a_capture_is_cut_only_where_both_reads_show_the_same_drawn_window() {
		let tdlg = atspi(5104, "TDLG", false);
		let alone = [atspi(5104, "TDLG", false)];
		let cut = |before: &str, after: &str| {
			agreed((&snapshot(before), &alone), (&snapshot(after), &alone), &tdlg.window, PORTAL)
		};
		assert_eq!(cut(CLIENTS, CLIENTS), Some(([12, 38], [621, 750])));
		// Moved or resized between the reads.
		assert_eq!(cut(CLIENTS, &CLIENTS.replacen("[12,38]", "[13,38]", 1)), None);
		assert_eq!(cut(CLIENTS, &CLIENTS.replacen("[621,750]", "[621,751]", 1)), None);
		// Mapped but not drawn (swallowed, an inactive group tab), in either
		// read.
		let hidden = CLIENTS.replacen(r#""visible":true"#, r#""visible":false"#, 1);
		assert_eq!(cut(&hidden, CLIENTS), None);
		assert_eq!(cut(CLIENTS, &hidden), None);
		// Closed and replaced in the same place: a new stable id.
		assert_eq!(
			cut(CLIENTS, &CLIENTS.replacen(r#""stableId":"11""#, r#""stableId":"21""#, 1)),
			None
		);
		// No stable id to compare.
		let anonymous = CLIENTS.replacen(r#","stableId":"11""#, "", 1);
		assert_eq!(cut(&anonymous, &anonymous), None);
		// On a workspace no monitor shows.
		let away = CLIENTS.replacen(
			r#""id":1,"name":"1"},"class":"tdlg.py""#,
			r#""id":2,"name":"2"},"class":"tdlg.py""#,
			1,
		);
		assert_eq!(cut(&away, &away), None);
		// A second accessible window of the app appeared by the second read.
		let dialog = [atspi(5104, "TDLG", false), atspi(5104, "Dialog", false)];
		assert_eq!(
			agreed((&snapshot(CLIENTS), &alone), (&snapshot(CLIENTS), &dialog), &tdlg.window, PORTAL),
			None
		);
	}

	#[test]
	fn a_capture_is_cut_only_from_the_monitor_hyprland_shows_the_window_on() {
		let tdlg = atspi(5104, "TDLG", false);
		let alone = [atspi(5104, "TDLG", false)];
		let cut = |monitors: &str, portal| {
			let read = Snapshot { clients: parse(CLIENTS), monitors: parse(monitors) };
			agreed((&read, &alone), (&read, &alone), &tdlg.window, portal)
		};
		assert!(cut(MONITORS, PORTAL).is_some());
		// The portal streams another compositor's monitor (nested Hyprland).
		assert_eq!(cut(MONITORS, (0, 0, 1920, 1080)), None);
		assert_eq!(cut(MONITORS, (1280, 0, 1280, 800)), None);
		// A 2560x1600 monitor at scale 2 is the 1280x800 logical stream.
		let scaled = MONITORS
			.replace(r#""width":1280,"height":800"#, r#""width":2560,"height":1600"#)
			.replace(r#""scale":1.0"#, r#""scale":2.0"#);
		assert!(cut(&scaled, PORTAL).is_some());
	}
}
