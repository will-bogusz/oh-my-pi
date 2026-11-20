//! Hyprland's own window list, read over its IPC socket (`hyprctl -j clients`).
//!
//! Native Wayland clients cannot learn where the compositor put them, so over
//! AT-SPI every window reports itself at `0,0`. Hyprland knows each client's
//! position, size, process and title. Nothing here writes to the compositor:
//! the one request reads its state.

use std::{
	io::{self, Read, Write},
	os::{
		fd::{FromRawFd, OwnedFd},
		unix::{ffi::OsStrExt, net::UnixStream},
	},
	path::{Path, PathBuf},
	time::{Duration, Instant},
};

use serde::Deserialize;

use super::peer_pid;
use crate::desktop::error::{CoreResult, DesktopError};

/// How long one IPC request may take, connection to last byte; Hyprland
/// answers in about a millisecond.
const IPC_TIMEOUT: Duration = Duration::from_secs(1);
/// The largest reply read; a `j/clients` of a hundred windows is about 100 KiB.
const MAX_REPLY: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug)]
pub(super) struct Hyprland {
	socket: PathBuf,
	/// The compositor's process, which must own the socket at every request.
	pid:    u32,
}

/// The keys read from each `j/clients` entry; a reply missing one is refused.
#[derive(Debug, Deserialize)]
struct Client {
	mapped: bool,
	at:     [i32; 2],
	size:   [i32; 2],
	pid:    i64,
	title:  String,
}

/// Where Hyprland shows one client.
pub(super) struct HyprlandClient {
	pub pid:    u32,
	pub title:  String,
	pub x:      i32,
	pub y:      i32,
	pub width:  u32,
	pub height: u32,
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

impl Hyprland {
	/// The Hyprland instance serving this session's Wayland socket, when the
	/// compositor (`compositor_pid`, from the socket's peer credentials) is
	/// Hyprland and its IPC socket belongs to that same process.
	pub(super) fn detect(compositor_pid: Option<u32>) -> Option<Self> {
		let pid = compositor_pid?;
		let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
		if comm.trim() != "Hyprland" {
			return None;
		}
		let signature = std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE")?;
		let socket = PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR")?)
			.join("hypr")
			.join(signature)
			.join(".socket.sock");
		let stream = connect(&socket).ok()?;
		(peer_pid(&stream) == Some(pid)).then_some(Self { socket, pid })
	}

	fn json<T: for<'de> Deserialize<'de>>(&self, command: &str) -> CoreResult<T> {
		let failed =
			|err: io::Error| DesktopError::ax_failed(format!("Hyprland IPC {command}: {err}"));
		let deadline = Instant::now() + IPC_TIMEOUT;
		let left = || {
			let left = deadline.saturating_duration_since(Instant::now());
			if left.is_zero() {
				Err(io::Error::from(io::ErrorKind::TimedOut))
			} else {
				Ok(left)
			}
		};
		let mut stream = connect(&self.socket).map_err(failed)?;
		if peer_pid(&stream) != Some(self.pid) {
			return Err(DesktopError::ax_failed(format!(
				"Hyprland IPC {command}: the socket no longer belongs to the compositor"
			)));
		}
		stream
			.set_write_timeout(Some(left().map_err(failed)?))
			.map_err(failed)?;
		stream.write_all(command.as_bytes()).map_err(failed)?;
		let mut reply = Vec::new();
		let mut chunk = [0; 16 * 1024];
		loop {
			stream
				.set_read_timeout(Some(left().map_err(failed)?))
				.map_err(failed)?;
			match stream.read(&mut chunk).map_err(failed)? {
				0 => break,
				read if reply.len() + read > MAX_REPLY => {
					return Err(DesktopError::ax_failed(format!(
						"Hyprland IPC {command}: reply over {MAX_REPLY} bytes"
					)));
				},
				read => reply.extend_from_slice(&chunk[..read]),
			}
		}
		serde_json::from_slice(&reply)
			.map_err(|err| DesktopError::ax_failed(format!("Hyprland IPC {command}: {err}")))
	}

	/// Every mapped client, or an error when one has a pid or size no window
	/// can have, so a reply Hyprland did not mean is never half used.
	pub(super) fn clients(&self) -> CoreResult<Vec<HyprlandClient>> {
		let clients: Vec<Client> = self.json("j/clients")?;
		clients
			.into_iter()
			.filter(|client| client.mapped)
			.map(|client| {
				Some(HyprlandClient {
					pid:    u32::try_from(client.pid).ok()?,
					title:  client.title,
					x:      client.at[0],
					y:      client.at[1],
					width:  u32::try_from(client.size[0]).ok()?,
					height: u32::try_from(client.size[1]).ok()?,
				})
			})
			.collect::<Option<_>>()
			.ok_or_else(|| {
				DesktopError::ax_failed("Hyprland IPC j/clients: a client has a negative pid or size")
			})
	}
}

/// The client showing the window of process `pid` titled `title`: the one
/// client with both. `None` when no client or several have them.
pub(super) fn client_for<'a>(
	clients: &'a [HyprlandClient],
	pid: Option<u32>,
	title: &str,
) -> Option<&'a HyprlandClient> {
	let pid = pid?;
	let mut same = clients
		.iter()
		.filter(|client| client.pid == pid && client.title == title);
	let client = same.next()?;
	same.next().is_none().then_some(client)
}

#[cfg(test)]
mod tests {
	use std::os::unix::net::UnixListener;

	use super::*;

	/// `j/clients` from Hyprland 0.56.2, trimmed: a GTK window, a terminal,
	/// and a window being closed.
	const CLIENTS: &str = r#"[
		{"address":"0x5501","mapped":true,"hidden":false,"at":[12,38],"size":[621,750],
		 "workspace":{"id":1,"name":"1"},"class":"tdlg.py","title":"TDLG","pid":5104,"focusHistoryID":0},
		{"address":"0x5502","mapped":true,"hidden":false,"at":[647,38],"size":[621,750],
		 "workspace":{"id":1,"name":"1"},"class":"foot","title":"foot","pid":4920,"focusHistoryID":1},
		{"address":"0x5507","mapped":false,"hidden":true,"at":[0,0],"size":[0,0],
		 "workspace":{"id":-1,"name":""},"class":"","title":"","pid":-1,"focusHistoryID":-1}
	]"#;

	/// A request socket owned by this process that answers one connection
	/// with `reply`, as Hyprland's does, then closes.
	fn serve(socket: PathBuf, reply: &'static str) -> Hyprland {
		let listener = UnixListener::bind(&socket).unwrap();
		std::thread::spawn(move || {
			let (mut stream, _) = listener.accept().unwrap();
			let mut request = [0; 64];
			let read = stream.read(&mut request).unwrap();
			assert_eq!(&request[..read], b"j/clients");
			stream.write_all(reply.as_bytes()).unwrap();
		});
		Hyprland { socket, pid: std::process::id() }
	}

	#[test]
	fn mapped_clients_are_read_with_their_place() {
		let dir = tempfile::tempdir().unwrap();
		let read: Vec<_> = serve(dir.path().join(".socket.sock"), CLIENTS)
			.clients()
			.unwrap()
			.into_iter()
			.map(|client| {
				(client.pid, client.title, (client.x, client.y, client.width, client.height))
			})
			.collect();
		assert_eq!(read, [
			(5104, "TDLG".to_owned(), (12, 38, 621, 750)),
			(4920, "foot".to_owned(), (647, 38, 621, 750)),
		]);
	}

	#[test]
	fn a_reply_that_is_not_a_whole_client_list_is_refused() {
		for reply in [
			"",
			"unknown request",
			// Cut off mid-list.
			r#"[{"mapped":true,"at":[12,38],"size":[621,750],"pid":5104,"title":"TDLG"},"#,
			// A key missing.
			r#"[{"mapped":true,"at":[12,38],"size":[621,750],"pid":5104}]"#,
			// A mapped client with a negative size.
			r#"[{"mapped":true,"at":[12,38],"size":[-1,750],"pid":5104,"title":"TDLG"}]"#,
		] {
			let dir = tempfile::tempdir().unwrap();
			assert!(
				serve(dir.path().join(".socket.sock"), reply)
					.clients()
					.is_err(),
				"{reply}"
			);
		}
	}

	#[test]
	fn a_socket_nobody_accepts_on_refuses_instead_of_blocking() {
		let dir = tempfile::tempdir().unwrap();
		let socket = dir.path().join(".socket.sock");
		let _listener = UnixListener::bind(&socket).unwrap();
		// Fill the accept queue: the connection after the last it holds is
		// refused at once.
		let mut held = Vec::new();
		let refused = loop {
			match connect(&socket) {
				Ok(stream) => held.push(stream),
				Err(error) => break error,
			}
			assert!(held.len() < 100_000, "the accept queue never filled");
		};
		assert_eq!(refused.kind(), io::ErrorKind::WouldBlock);
	}

	#[test]
	fn a_window_takes_the_one_client_of_its_process_and_title() {
		let client = |pid, title: &str, x| HyprlandClient {
			pid,
			title: title.to_owned(),
			x,
			y: 0,
			width: 10,
			height: 10,
		};
		let clients = [
			client(10, "Editor", 1),
			client(20, "Main", 2),
			client(20, "Dialog", 3),
			client(30, "Same", 4),
			client(30, "Same", 5),
		];
		let x = |pid, title| client_for(&clients, Some(pid), title).map(|client| client.x);
		assert_eq!(x(10, "Editor"), Some(1));
		assert_eq!(x(20, "Dialog"), Some(3));
		// The title changed since AT-SPI read it: not this window's place.
		assert_eq!(x(10, "Editor — modified"), None);
		assert_eq!(x(20, "Popup"), None);
		// Two clients the title does not tell apart: neither.
		assert_eq!(x(30, "Same"), None);
		assert_eq!(x(40, "Other"), None);
		assert_eq!(client_for(&clients, None, "Editor").map(|client| client.x), None);
	}
}
