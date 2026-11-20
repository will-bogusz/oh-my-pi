//! Hyprland's own window list, read over its IPC socket (`hyprctl -j clients`).
//!
//! Native Wayland clients cannot learn where the compositor put them, so their
//! toolkits answer AT-SPI screen coordinates with window ones. Hyprland knows
//! each client's position, size, workspace and process; feeding that to
//! [`AtSpiAx`](crate::desktop::linux::ax::AtSpiAx) as its native window list
//! places every element on screen, the way X11 does for GTK4. Nothing here
//! writes to the compositor: the three requests read its state.

use std::{
	io::{Read, Write},
	os::unix::net::UnixStream,
	path::PathBuf,
	time::{Duration, Instant},
};

use serde::Deserialize;

use super::peer_pid;
use crate::desktop::{
	error::{CoreResult, DesktopError},
	linux::ax::{NativeGeometry, NativeWindows},
	types::DesktopWindow,
};

/// How long one IPC request may take, connection to last byte; Hyprland
/// answers in about a millisecond.
const IPC_TIMEOUT: Duration = Duration::from_secs(1);
/// Prefix of the window ids this provider hands out.
const ID_PREFIX: &str = "hyprland:";

#[derive(Clone, Debug)]
pub(super) struct Hyprland {
	socket: PathBuf,
	/// The compositor's process, which must own the socket at every request.
	pid:    u32,
}

/// A workspace by its name, which Hyprland keeps unique and prints in every
/// version; 0.57 leaves out the `id` of named and special workspaces.
#[derive(Debug, Deserialize)]
struct Workspace {
	#[serde(default)]
	name: String,
}

impl Workspace {
	/// Whether this is `other`. A monitor with no special workspace open
	/// names it `""`, which is no workspace at all.
	fn is(&self, other: &Self) -> bool {
		!self.name.is_empty() && self.name == other.name
	}
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Client {
	address:   String,
	mapped:    bool,
	hidden:    bool,
	at:        [i32; 2],
	size:      [i32; 2],
	workspace: Workspace,
	pid:       i64,
	#[serde(default)]
	class:     String,
	#[serde(default)]
	title:     String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Monitor {
	active_workspace:  Workspace,
	special_workspace: Workspace,
}

/// `j/activewindow`: `{}` while no window has focus.
#[derive(Debug, Deserialize)]
struct ActiveWindow {
	#[serde(default)]
	address: String,
}

/// One Hyprland client as OMP lists it.
pub(super) struct HyprlandWindow {
	pub window:  DesktopWindow,
	/// On a workspace some monitor shows, so a screen capture shows it there.
	pub visible: bool,
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
		let stream = UnixStream::connect(&socket).ok()?;
		(peer_pid(&stream) == Some(pid)).then_some(Self { socket, pid })
	}

	fn json<T: for<'de> Deserialize<'de>>(&self, command: &str) -> CoreResult<T> {
		let failed =
			|err: std::io::Error| DesktopError::ax_failed(format!("Hyprland IPC {command}: {err}"));
		let deadline = Instant::now() + IPC_TIMEOUT;
		let mut stream = UnixStream::connect(&self.socket).map_err(failed)?;
		if peer_pid(&stream) != Some(self.pid) {
			return Err(DesktopError::ax_failed(format!(
				"Hyprland IPC {command}: the socket no longer belongs to the compositor"
			)));
		}
		stream
			.set_write_timeout(Some(IPC_TIMEOUT))
			.map_err(failed)?;
		stream.write_all(command.as_bytes()).map_err(failed)?;
		let mut reply = Vec::new();
		let mut chunk = [0; 16 * 1024];
		loop {
			let left = deadline.saturating_duration_since(Instant::now());
			if left.is_zero() {
				return Err(DesktopError::ax_failed(format!(
					"Hyprland IPC {command}: no complete reply within {IPC_TIMEOUT:?}"
				)));
			}
			stream.set_read_timeout(Some(left)).map_err(failed)?;
			match stream.read(&mut chunk).map_err(failed)? {
				0 => break,
				read => reply.extend_from_slice(&chunk[..read]),
			}
		}
		serde_json::from_slice(&reply)
			.map_err(|err| DesktopError::ax_failed(format!("Hyprland IPC {command}: {err}")))
	}

	/// Every mapped client, with whether a monitor shows its workspace.
	pub(super) fn list(&self) -> CoreResult<Vec<HyprlandWindow>> {
		let clients: Vec<Client> = self.json("j/clients")?;
		let monitors: Vec<Monitor> = self.json("j/monitors")?;
		let active: ActiveWindow = self.json("j/activewindow")?;
		Ok(clients
			.into_iter()
			.filter(|client| client.mapped && client.size[0] > 0 && client.size[1] > 0)
			.map(|client| {
				let visible = !client.hidden
					&& monitors.iter().any(|monitor| {
						monitor.active_workspace.is(&client.workspace)
							|| monitor.special_workspace.is(&client.workspace)
					});
				HyprlandWindow {
					window: DesktopWindow {
						id:      format!("{ID_PREFIX}{}", client.address),
						title:   client.title,
						app:     client.class,
						pid:     u32::try_from(client.pid).ok(),
						x:       client.at[0],
						y:       client.at[1],
						width:   client.size[0] as u32,
						height:  client.size[1] as u32,
						focused: client.address == active.address,
					},
					visible,
				}
			})
			.collect())
	}
}

/// The Hyprland client showing an AT-SPI frame of process `pid` titled
/// `title`: the process's only client, or else its only client with that
/// title. `None` when the process has no client or several that the title
/// does not tell apart.
pub(super) fn client_for_frame<'a>(
	windows: impl IntoIterator<Item = &'a DesktopWindow>,
	pid: Option<u32>,
	title: &str,
) -> Option<&'a DesktopWindow> {
	let pid = pid?;
	let mut same_process: Vec<&DesktopWindow> = windows
		.into_iter()
		.filter(|window| window.id.starts_with(ID_PREFIX) && window.pid == Some(pid))
		.collect();
	if same_process.len() > 1 {
		same_process.retain(|window| window.title == title);
	}
	match same_process.as_slice() {
		[only] => Some(only),
		_ => None,
	}
}

impl NativeWindows for Hyprland {
	fn windows(&self) -> CoreResult<Vec<DesktopWindow>> {
		Ok(self.list()?.into_iter().map(|entry| entry.window).collect())
	}

	/// Only while a monitor shows the window: a frame on a hidden workspace
	/// claims no point of the screen.
	fn geometry(&self, id: &str) -> Option<NativeGeometry> {
		let entry = self
			.list()
			.ok()?
			.into_iter()
			.find(|entry| entry.window.id == id && entry.visible)?;
		Some(NativeGeometry {
			x:      entry.window.x,
			y:      entry.window.y,
			width:  entry.window.width,
			height: entry.window.height,
			shadow: [0; 4],
		})
	}

	fn screen_is_window_relative(&self) -> bool {
		true
	}

	fn window_for_frame(&self, pid: u32, title: &str) -> CoreResult<String> {
		let windows = self.windows()?;
		client_for_frame(&windows, Some(pid), title)
			.map(|window| window.id.clone())
			.ok_or_else(|| {
				DesktopError::window_not_found(
					"no single Hyprland client of the frame's process matches its title",
				)
			})
	}
}

#[cfg(test)]
mod tests {
	use std::os::unix::net::UnixListener;

	use super::*;

	/// `j/clients` as Hyprland 0.56.2 prints it, trimmed to the keys read, plus
	/// the 0.57 shape of named and special workspaces (no `id`): the focused
	/// window, a terminal on hidden workspace 2, a window on a shown named
	/// workspace, one on a hidden named workspace, one on the open special
	/// workspace, one on a closed special workspace, and a closing window.
	const CLIENTS: &str = r#"[
		{"address":"0x5501","mapped":true,"hidden":false,"at":[12,38],"size":[621,750],
		 "workspace":{"id":1,"name":"1"},"class":"tdlg.py","title":"TDLG","pid":5104,"focusHistoryID":0},
		{"address":"0x5502","mapped":true,"hidden":false,"at":[12,38],"size":[1256,750],
		 "workspace":{"id":2,"name":"2"},"class":"foot","title":"foot","pid":4920,"focusHistoryID":1},
		{"address":"0x5503","mapped":true,"hidden":false,"at":[1292,38],"size":[1256,750],
		 "workspace":{"name":"name:notes"},"class":"notes","title":"Notes","pid":6001,"focusHistoryID":2},
		{"address":"0x5504","mapped":true,"hidden":false,"at":[1292,38],"size":[1256,750],
		 "workspace":{"name":"name:mail"},"class":"mail","title":"Mail","pid":6002,"focusHistoryID":3},
		{"address":"0x5505","mapped":true,"hidden":false,"at":[112,88],"size":[1056,650],
		 "workspace":{"name":"special:magic"},"class":"calc","title":"Calc","pid":6003,"focusHistoryID":4},
		{"address":"0x5506","mapped":true,"hidden":false,"at":[112,88],"size":[1056,650],
		 "workspace":{"name":"special:other"},"class":"todo","title":"Todo","pid":6004,"focusHistoryID":5},
		{"address":"0x5507","mapped":false,"hidden":true,"at":[0,0],"size":[0,0],
		 "workspace":{"id":-1,"name":""},"class":"","title":"","pid":-1,"focusHistoryID":-1}
	]"#;
	/// `j/monitors`, trimmed: workspace 1 with special:magic open over it, and
	/// the named workspace notes on a second monitor with no special open.
	const MONITORS: &str = r#"[
		{"id":0,"name":"Virtual-1","activeWorkspace":{"id":1,"name":"1"},
		 "specialWorkspace":{"address":"0x9a01","name":"special:magic"}},
		{"id":1,"name":"Virtual-2","activeWorkspace":{"address":"0x9a02","name":"name:notes"},
		 "specialWorkspace":{"address":"","type":"","name":""}}
	]"#;
	const ACTIVE: &str = r#"{"address":"0x5501","title":"TDLG","pid":5104}"#;

	/// A request socket owned by this process that answers one connection per
	/// command in `replies`, as Hyprland's does, then closes.
	fn serve(socket: PathBuf, replies: &'static [(&'static str, &'static str)]) -> Hyprland {
		let listener = UnixListener::bind(&socket).unwrap();
		std::thread::spawn(move || {
			for stream in listener.incoming().take(replies.len()) {
				let mut stream = stream.unwrap();
				let mut request = [0; 64];
				let read = stream.read(&mut request).unwrap();
				let reply = replies
					.iter()
					.find(|(command, _)| command.as_bytes() == &request[..read])
					.map_or("", |(_, reply)| reply);
				stream.write_all(reply.as_bytes()).unwrap();
			}
		});
		Hyprland { socket, pid: std::process::id() }
	}

	#[test]
	fn clients_are_listed_where_and_whether_hyprland_shows_them() {
		let dir = tempfile::tempdir().unwrap();
		let hyprland = serve(dir.path().join(".socket.sock"), &[
			("j/clients", CLIENTS),
			("j/monitors", MONITORS),
			("j/activewindow", ACTIVE),
		]);
		let listed: Vec<_> = hyprland
			.list()
			.unwrap()
			.into_iter()
			.map(|client| {
				let DesktopWindow { title, x, y, width, height, focused, .. } = client.window;
				(title, (x, y, width, height), focused, client.visible)
			})
			.collect();
		let row = |title: &str, at, focused, visible| (title.to_owned(), at, focused, visible);
		assert_eq!(listed, [
			row("TDLG", (12, 38, 621, 750), true, true),
			row("foot", (12, 38, 1256, 750), false, false),
			row("Notes", (1292, 38, 1256, 750), false, true),
			row("Mail", (1292, 38, 1256, 750), false, false),
			row("Calc", (112, 88, 1056, 650), false, true),
			row("Todo", (112, 88, 1056, 650), false, false),
		]);
	}

	fn window(id: &str, pid: u32, title: &str) -> DesktopWindow {
		DesktopWindow {
			id:      id.to_owned(),
			title:   title.to_owned(),
			app:     String::new(),
			pid:     Some(pid),
			x:       0,
			y:       0,
			width:   10,
			height:  10,
			focused: false,
		}
	}

	#[test]
	fn a_frame_matches_its_process_alone_or_by_title_and_never_guesses() {
		let windows = [
			window("hyprland:0x1", 10, "Editor"),
			window("hyprland:0x2", 20, "Main"),
			window("hyprland:0x3", 20, "Dialog"),
			window("hyprland:0x4", 30, "Same"),
			window("hyprland:0x5", 30, "Same"),
			window("atspi::1.2:/a", 40, "Other"),
		];
		let id = |pid, title| client_for_frame(&windows, Some(pid), title).map(|w| w.id.as_str());
		// A process with one client: its title may have changed since.
		assert_eq!(id(10, "Editor — modified"), Some("hyprland:0x1"));
		assert_eq!(id(20, "Dialog"), Some("hyprland:0x3"));
		assert_eq!(id(20, "Popup"), None);
		assert_eq!(id(30, "Same"), None);
		assert_eq!(id(40, "Other"), None);
		assert!(client_for_frame(&windows, None, "Editor").is_none());
	}
}
