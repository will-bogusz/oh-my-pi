//! Where Hyprland shows each window, read over its IPC socket (`hyprctl -j`).
//! A native Wayland client cannot learn where the compositor put it, so over
//! AT-SPI its window reads `0,0` and its elements read positions inside the
//! window. Requests only read; nothing is kept from one to the next, and any
//! failure leaves the caller with what AT-SPI said.

use std::{
	io::{self, Read, Write},
	os::{
		fd::{FromRawFd, OwnedFd},
		unix::{ffi::OsStrExt, net::UnixStream},
	},
	path::{Path, PathBuf},
	sync::{Arc, Mutex},
	time::{Duration, Instant},
};

use serde::{Deserialize, de::DeserializeOwned};

use super::{compositor_pid, peer_pid};
use crate::desktop::{
	error::{CoreResult, DesktopError},
	linux::ax::{AtSpiAx, AtSpiWindow, NativeGeometry, NativeWindows},
	types::DesktopWindow,
};

/// How long one read of Hyprland's state may take, connection to last byte;
/// Hyprland answers in about a millisecond.
const IPC_TIMEOUT: Duration = Duration::from_secs(1);
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
pub(super) struct Client {
	address:   String,
	mapped:    bool,
	at:        [i32; 2],
	size:      [u32; 2],
	workspace: Workspace,
	pid:       i64,
	title:     String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Monitor {
	active_workspace:  Workspace,
	special_workspace: Workspace,
}

/// Hyprland's state as one read saw it.
pub(super) struct Snapshot {
	clients: Vec<Client>,
	/// The workspaces some monitor shows, special ones included.
	shown:   Vec<String>,
}

/// The request socket of the Hyprland serving this session's Wayland socket.
pub(super) struct Session {
	socket:     PathBuf,
	compositor: u32,
}

/// Connects without waiting: a socket whose compositor stopped accepting,
/// with its queue full, refuses at once instead of blocking the call.
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

/// `ax` placing native Wayland windows by Hyprland's list ([`Windows`]) when
/// this session's compositor is Hyprland: its Wayland socket is served by a
/// process named `Hyprland` and the session names an instance.
pub(super) fn placing(ax: AtSpiAx) -> AtSpiAx {
	let hyprland = std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some()
		&& compositor_pid()
			.and_then(|pid| std::fs::read_to_string(format!("/proc/{pid}/comm")).ok())
			.is_some_and(|comm| comm.trim_end() == "Hyprland");
	if hyprland { ax.with_native_windows(Box::new(Windows::default())) } else { ax }
}

impl Session {
	/// Hyprland's socket for this session, found again at every read; `None`
	/// outside Hyprland.
	pub(super) fn current() -> Option<Self> {
		let signature = std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE")?;
		let socket = PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR")?)
			.join("hypr")
			.join(signature)
			.join(".socket.sock");
		Some(Self { socket, compositor: compositor_pid()? })
	}

	/// One request, answered by the compositor itself before `deadline`.
	fn request<T: DeserializeOwned>(&self, command: &str, deadline: Instant) -> CoreResult<Vec<T>> {
		let failed =
			|err: io::Error| DesktopError::ax_failed(format!("Hyprland IPC {command}: {err}"));
		let left = || {
			let left = deadline.saturating_duration_since(Instant::now());
			if left.is_zero() { Err(failed(io::ErrorKind::TimedOut.into())) } else { Ok(left) }
		};
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

	/// Every client, mapped or not.
	pub(super) fn clients(&self) -> CoreResult<Vec<Client>> {
		self.request("j/clients", Instant::now() + IPC_TIMEOUT)
	}

	/// Clients and the shown workspaces, read under one deadline.
	pub(super) fn snapshot(&self) -> CoreResult<Snapshot> {
		self.read(Instant::now() + IPC_TIMEOUT)
	}

	fn read(&self, deadline: Instant) -> CoreResult<Snapshot> {
		let clients = self.request("j/clients", deadline)?;
		Ok(Snapshot::new(clients, &self.request("j/monitors", deadline)?))
	}
}

impl Snapshot {
	fn new(clients: Vec<Client>, monitors: &[Monitor]) -> Self {
		let shown = monitors
			.iter()
			.flat_map(|monitor| [&monitor.active_workspace, &monitor.special_workspace])
			.filter_map(Workspace::key)
			.collect();
		Self { clients, shown }
	}
}

/// The client showing AT-SPI window `window`: the one client of its process
/// with its title, while no other AT-SPI window (`windows`) of that process
/// has that title either, and the client is mapped at the size AT-SPI reports.
/// `None` otherwise: nothing else ties the two lists together.
pub(super) fn client_for<'a>(
	clients: &'a [Client],
	windows: &[AtSpiWindow],
	window: &DesktopWindow,
) -> Option<&'a Client> {
	let pid = window.pid?;
	let namesakes = windows
		.iter()
		.filter(|other| other.window.pid == Some(pid) && other.window.title == window.title)
		.count();
	let mut same = clients
		.iter()
		.filter(|client| client.pid == i64::from(pid) && client.title == window.title);
	let client = same.next()?;
	(namesakes == 1
		&& same.next().is_none()
		&& client.mapped
		&& client.size == [window.width, window.height])
		.then_some(client)
}

/// AT-SPI's windows as listed: each whose toolkit gives no position takes the
/// position of its one client (`client_for`, which has its size); every other
/// field, and every other window, stays AT-SPI's.
pub(super) fn listed(windows: Vec<AtSpiWindow>, clients: &[Client]) -> Vec<DesktopWindow> {
	let places: Vec<_> = windows
		.iter()
		.map(|entry| {
			let client = client_for(clients, &windows, &entry.window)?;
			(!entry.position_known).then_some(client.at)
		})
		.collect();
	windows
		.into_iter()
		.zip(places)
		.map(|(AtSpiWindow { mut window, .. }, place)| {
			if let Some([x, y]) = place {
				(window.x, window.y) = (x, y);
			}
			window
		})
		.collect()
}

/// Where a capture of AT-SPI window `window` is cut: the position of the same
/// client, on the same shown workspace, in the same place in `before` and
/// `after`, the reads taken on either side of the frame. `None` when either
/// read cannot say.
pub(super) fn agreed(
	before: &Snapshot,
	after: &Snapshot,
	windows: &[AtSpiWindow],
	window: &DesktopWindow,
) -> Option<[i32; 2]> {
	let shown = before.shown(windows, window)?;
	(after.shown(windows, window)? == shown).then_some(shown.2)
}

impl Snapshot {
	/// The client showing `window` (`client_for`), its workspace and place,
	/// while some monitor shows that workspace and no other window of its
	/// process has its size: a title can pass from one window to another
	/// while the frame is taken, and a size then still tells them apart.
	fn shown(
		&self,
		windows: &[AtSpiWindow],
		window: &DesktopWindow,
	) -> Option<(&str, String, [i32; 2], [u32; 2])> {
		let client = client_for(&self.clients, windows, window)?;
		let workspace = client.workspace.key().filter(|key| self.shown.contains(key))?;
		let alike = |other: &&Client| other.mapped && other.pid == client.pid && other.size == client.size;
		(self.clients.iter().filter(alike).count() == 1)
			.then(|| (client.address.as_str(), workspace, client.at, client.size))
	}
}

/// Places AT-SPI elements of native Wayland windows by where Hyprland shows
/// their window. One `j/clients` read serves an operation: it is dropped at
/// the next ([`NativeWindows::refresh`]).
#[derive(Default)]
pub(super) struct Windows {
	read: Mutex<Option<Option<Arc<Vec<Client>>>>>,
}

impl Windows {
	fn clients(&self) -> Option<Arc<Vec<Client>>> {
		let mut read = self.read.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
		read
			.get_or_insert_with(|| Some(Arc::new(Session::current()?.clients().ok()?)))
			.clone()
	}
}

impl NativeWindows for Windows {
	/// Every client, mapped or not, so a title two of them share matches
	/// neither.
	fn windows(&self) -> CoreResult<Vec<DesktopWindow>> {
		let clients = self
			.clients()
			.ok_or_else(|| DesktopError::ax_failed("Hyprland IPC j/clients: no answer"))?;
		Ok(clients
			.iter()
			.filter_map(|client| {
				Some(DesktopWindow {
					id:      client.address.clone(),
					title:   client.title.clone(),
					app:     String::new(),
					pid:     Some(u32::try_from(client.pid).ok()?),
					x:       client.at[0],
					y:       client.at[1],
					width:   client.size[0],
					height:  client.size[1],
					focused: false,
				})
			})
			.collect())
	}

	/// While client `id` (its address) is mapped and still the only one of
	/// its process with its title: a frame matched earlier is matched again
	/// once that stops holding.
	fn geometry(&self, id: &str) -> Option<NativeGeometry> {
		let clients = self.clients()?;
		let client = clients.iter().find(|client| client.address == id)?;
		let namesakes = clients
			.iter()
			.filter(|other| other.pid == client.pid && other.title == client.title)
			.count();
		(client.mapped && namesakes == 1).then(|| NativeGeometry {
			x:      client.at[0],
			y:      client.at[1],
			width:  client.size[0],
			height: client.size[1],
			shadow: [0; 4],
		})
	}

	fn screen_is_window_relative(&self) -> bool {
		true
	}

	fn refresh(&self) {
		*self.read.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
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
		 "workspace":{"id":1,"name":"1"},"class":"tdlg.py","title":"TDLG","pid":5104,"focusHistoryID":0},
		{"address":"0x5502","mapped":true,"hidden":false,"visible":true,"at":[647,38],"size":[621,750],
		 "workspace":{"id":1,"name":"1"},"class":"foot","title":"foot","pid":4920,"focusHistoryID":1},
		{"address":"0x5503","mapped":true,"hidden":false,"visible":true,"at":[12,38],"size":[1256,750],
		 "workspace":{"id":2,"name":"2"},"class":"org.gnome.Nautilus","title":"Home","pid":6001,"focusHistoryID":2},
		{"address":"0x5504","mapped":true,"hidden":false,"visible":true,"at":[112,88],"size":[1056,650],
		 "workspace":{"id":-98,"name":"special:magic"},"class":"calc","title":"Calc","pid":6003,"focusHistoryID":3},
		{"address":"0x5507","mapped":false,"hidden":true,"visible":false,"at":[0,0],"size":[0,0],
		 "workspace":{"id":-1,"name":""},"class":"","title":"","pid":-1,"focusHistoryID":-1}
	]"#;

	/// `j/monitors` from 0.56.2, trimmed: workspace 1 shown, no special one.
	const MONITORS: &str = r#"[{"id":0,"name":"Virtual-1","x":0,"y":0,
		"activeWorkspace":{"id":1,"name":"1"},"specialWorkspace":{"id":0,"name":""}}]"#;

	/// A request socket owned by this process that answers one connection per
	/// `(command, reply)`, as Hyprland's does, then closes it.
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
				id: format!("atspi:{title}"),
				title: title.into(),
				app: "app".into(),
				pid: Some(pid),
				x: 0,
				y: 0,
				width: 621,
				height: 750,
				focused: title == "TDLG",
			},
			position_known,
		}
	}

	fn client(address: &str, pid: i64, title: &str, mapped: bool, workspace: i64) -> Client {
		Client {
			address: address.into(),
			mapped,
			at: [10, 20],
			size: [621, 750],
			workspace: Workspace { id: Some(workspace), address: None },
			pid,
			title: title.into(),
		}
	}

	#[test]
	fn clients_and_shown_workspaces_are_read_one_request_each() {
		let dir = tempfile::tempdir().unwrap();
		let hyprland = serve(dir.path().join(".socket.sock"), vec![
			("j/clients", CLIENTS),
			("j/monitors", MONITORS),
		]);
		let snapshot = hyprland.read(unhurried()).unwrap();
		let read: Vec<_> = snapshot
			.clients
			.iter()
			.map(|client| (client.address.as_str(), client.pid, client.title.as_str(), client.at))
			.collect();
		assert_eq!(read, [
			("0x5501", 5104, "TDLG", [12, 38]),
			("0x5502", 4920, "foot", [647, 38]),
			("0x5503", 6001, "Home", [12, 38]),
			("0x5504", 6003, "Calc", [112, 88]),
			("0x5507", -1, "", [0, 0]),
		]);
		assert_eq!(snapshot.shown, ["1"]);
	}

	#[test]
	fn a_reply_that_is_not_a_whole_object_list_is_refused() {
		const ROW: &str = r#"{"address":"0x1","mapped":true,"at":[12,38],"size":[621,750],"workspace":{"id":1},"pid":5104,"title":"TDLG"}"#;
		for reply in [
			String::new(),
			"unknown request".to_owned(),
			"{}".to_owned(),
			// Cut off mid-list.
			format!("[{ROW},"),
			// A key missing.
			format!("[{}]", ROW.replace(r#","title":"TDLG""#, "")),
			// A negative size.
			format!("[{}]", ROW.replace("[621,750]", "[-1,750]")),
			// A row in positional form after a whole one.
			format!(r#"[{ROW},["0x2",true,[12,38],[621,750],{{"id":1}},5104,"TDLG"]]"#),
		] {
			assert!(objects::<Client>(reply.as_bytes()).is_err(), "{reply}");
		}
		assert_eq!(objects::<Client>(format!("[{ROW}]").as_bytes()).unwrap().len(), 1);
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
		assert!(hyprland.request::<Client>("j/clients", unhurried()).is_err());
		let (mut stream, _) = listener.accept().unwrap();
		assert_eq!(stream.read(&mut [0; 64]).unwrap(), 0);
	}

	#[test]
	fn a_window_takes_the_one_client_of_its_process_and_title() {
		let clients = [
			client("0x1", 10, "Editor", true, 1),
			client("0x2", 20, "Main", true, 1),
			client("0x3", 20, "Dialog", true, 1),
			client("0x4", 30, "Same", true, 1),
			client("0x5", 30, "Same", true, 1),
			// A closing window still shares its title.
			client("0x6", 40, "Viewer", true, 1),
			client("0x7", 40, "Viewer", false, -1),
			client("0x8", 50, "Hidden", false, -1),
			client("0x9", 60, "Find", true, 1),
		];
		let windows = [
			atspi(10, "Editor", false),
			atspi(20, "Dialog", false),
			atspi(30, "Same", false),
			atspi(40, "Viewer", false),
			atspi(50, "Hidden", false),
			// Two AT-SPI windows of one process titled alike, one client.
			atspi(60, "Find", false),
			atspi(60, "Find", false),
		];
		let address = |pid, title: &str| {
			let window = DesktopWindow { pid, ..atspi(0, title, false).window };
			client_for(&clients, &windows, &window).map(|client| client.address.clone())
		};
		assert_eq!(address(Some(10), "Editor").as_deref(), Some("0x1"));
		assert_eq!(address(Some(20), "Dialog").as_deref(), Some("0x3"));
		// The title changed since AT-SPI read it: not this window's client.
		assert_eq!(address(Some(10), "Editor — modified"), None);
		assert_eq!(address(Some(30), "Same"), None);
		assert_eq!(address(Some(40), "Viewer"), None);
		assert_eq!(address(Some(50), "Hidden"), None);
		assert_eq!(address(Some(60), "Find"), None);
		assert_eq!(address(None, "Editor"), None);
	}

	#[test]
	fn only_windows_without_a_position_are_listed_where_hyprland_shows_them() {
		let clients: Vec<Client> = parse(CLIENTS);
		let windows = || {
			vec![
				atspi(5104, "TDLG", false),
				// A toolkit that knows its position keeps it.
				atspi(4920, "foot", true),
				// On a workspace no monitor shows: listed where it is there.
				AtSpiWindow {
					window: DesktopWindow { width: 1256, ..atspi(6001, "Home", false).window },
					position_known: false,
				},
				// The title changed since Hyprland read it.
				atspi(6003, "Calculator", false),
				// The size AT-SPI reports is not the client's.
				atspi(6003, "Calc", false),
			]
		};
		let placed: Vec<_> = listed(windows(), &clients)
			.into_iter()
			.map(|window| (window.x, window.y, window.width, window.height, window.focused))
			.collect();
		assert_eq!(placed, [
			(12, 38, 621, 750, true),
			(0, 0, 621, 750, false),
			(12, 38, 1256, 750, false),
			(0, 0, 621, 750, false),
			(0, 0, 621, 750, false),
		]);
		// Without clients, AT-SPI's list field for field.
		let unplaced: Vec<_> = windows().into_iter().map(|entry| entry.window).collect();
		assert_eq!(format!("{:?}", listed(windows(), &[])), format!("{unplaced:?}"));
	}

	#[test]
	fn workspaces_are_told_apart_by_id_or_address_never_by_name() {
		// 0.57: named workspaces have no `id`; two can share a displayed name.
		let clients: Vec<Client> = parse(
			r#"[
			{"address":"0x1","mapped":true,"at":[0,0],"size":[621,750],"pid":1,"title":"Mail",
			 "workspace":{"address":"name:mail","type":"named","name":"Mail"}},
			{"address":"0x2","mapped":true,"at":[0,0],"size":[621,750],"pid":2,"title":"Inbox",
			 "workspace":{"address":"name:inbox","type":"named","name":"Mail"}},
			{"address":"0x3","mapped":true,"at":[0,0],"size":[621,750],"pid":3,"title":"Term",
			 "workspace":{"address":"1","id":1,"type":"numbered","name":"1"}}
		]"#,
		);
		let monitors: Vec<Monitor> = parse(
			r#"[{"activeWorkspace":{"address":"name:inbox","type":"named","name":"Mail"},
			 "specialWorkspace":{"address":"","type":"special","name":""}}]"#,
		);
		let snapshot = Snapshot::new(clients, &monitors);
		let windows = [atspi(1, "Mail", false), atspi(2, "Inbox", false), atspi(3, "Term", false)];
		let shown: Vec<_> = windows
			.iter()
			.map(|entry| snapshot.shown(&windows, &entry.window).is_some())
			.collect();
		assert_eq!(shown, [false, true, false]);
		assert_eq!(Workspace { id: Some(0), address: None }.key(), None);
		assert_eq!(Workspace { id: Some(-1), address: None }.key(), None);
		assert_eq!(Workspace::default().key(), None);
	}

	#[test]
	fn a_capture_is_cut_only_where_both_reads_agree() {
		let monitors: Vec<Monitor> = parse(MONITORS);
		let special: Vec<Monitor> = parse(
			r#"[{"activeWorkspace":{"id":1,"name":"1"},
			 "specialWorkspace":{"id":-98,"name":"special:magic"}}]"#,
		);
		let windows = [atspi(10, "Editor", false)];
		let window = &windows[0].window;
		let read = |client: Client, monitors: &[Monitor]| Snapshot::new(vec![client], monitors);
		let editor = || client("0x1", 10, "Editor", true, 1);
		let cut = |before: Snapshot, after: Snapshot| {
			agreed(&before, &after, &windows, window).map(|[x, y]| (x, y))
		};
		assert_eq!(cut(read(editor(), &monitors), read(editor(), &monitors)), Some((10, 20)));
		// Moved to another workspace in the same place.
		let away = client("0x1", 10, "Editor", true, 2);
		assert_eq!(cut(read(editor(), &monitors), read(away, &monitors)), None);
		// Closed and replaced by a window of the same process, title and place.
		assert_eq!(
			cut(read(editor(), &monitors), read(client("0x2", 10, "Editor", true, 1), &monitors)),
			None
		);
		// Moved within the workspace.
		let shifted = Client { at: [11, 20], ..editor() };
		assert_eq!(cut(read(editor(), &monitors), read(shifted, &monitors)), None);
		// On a workspace no monitor shows, in both reads.
		let hidden = || client("0x1", 10, "Editor", true, 2);
		assert_eq!(cut(read(hidden(), &monitors), read(hidden(), &monitors)), None);
		// On the special workspace a monitor shows.
		let magic = || client("0x1", 10, "Editor", true, -98);
		assert_eq!(cut(read(magic(), &special), read(magic(), &special)), Some((10, 20)));
		// The special workspace was closed between the reads.
		assert_eq!(cut(read(magic(), &special), read(magic(), &monitors)), None);
		// Another window of the process at the same size: only the titles
		// tell them apart, and those can swap while the frame is taken.
		let pair = |size| {
			let other = Client { address: "0x2".into(), title: "Other".into(), size, ..editor() };
			Snapshot::new(vec![editor(), other], &monitors)
		};
		assert_eq!(cut(pair([621, 750]), pair([621, 750])), None);
		assert_eq!(cut(pair([300, 750]), pair([300, 750])), Some((10, 20)));
	}

	#[test]
	fn elements_are_placed_from_one_client_list_per_operation() {
		let placing = Windows { read: Mutex::new(Some(Some(Arc::new(parse(CLIENTS))))) };
		let ids: Vec<_> = placing
			.windows()
			.unwrap()
			.into_iter()
			.map(|window| window.id)
			.collect();
		// The closing window's pid is no process.
		assert_eq!(ids, ["0x5501", "0x5502", "0x5503", "0x5504"]);
		let geometry =
			|id: &str| placing.geometry(id).map(|g| (g.x, g.y, g.width, g.height));
		assert_eq!(geometry("0x5501"), Some((12, 38, 621, 750)));
		assert_eq!(geometry("0x5507"), None);
		assert_eq!(geometry("0x9999"), None);
		// A second window of the process takes the title: the first is no
		// longer told apart.
		let mut clients: Vec<Client> = parse(CLIENTS);
		clients.push(client("0x5508", 5104, "TDLG", true, 1));
		*placing.read.lock().unwrap() = Some(Some(Arc::new(clients)));
		assert_eq!(geometry("0x5501"), None);
		placing.refresh();
		assert!(placing.read.lock().unwrap().is_none());
	}
}
