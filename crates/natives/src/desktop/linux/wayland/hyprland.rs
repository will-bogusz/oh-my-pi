//! Hyprland's own window list, read over its IPC socket (`hyprctl -j clients`).
//!
//! Native Wayland clients cannot learn where the compositor put them, so their
//! toolkits answer AT-SPI screen coordinates with window ones. Hyprland knows
//! each client's position, size, workspace and process; feeding that to
//! [`AtSpiAx`](crate::desktop::linux::ax::AtSpiAx) as its native window list
//! places every element on screen, the way X11 does for GTK4.

use std::{
	io::{Read, Write},
	os::unix::net::UnixStream,
	path::PathBuf,
	time::Duration,
};

use serde::Deserialize;

use super::peer_pid;
use crate::desktop::{
	error::{CoreResult, DesktopError},
	linux::ax::{NativeGeometry, NativeWindows},
	types::DesktopWindow,
};

/// How long one IPC request may take; Hyprland answers in about a millisecond.
const IPC_TIMEOUT: Duration = Duration::from_secs(1);
/// Prefix of the window ids this provider hands out.
const ID_PREFIX: &str = "hyprland:";

#[derive(Clone, Debug)]
pub(super) struct Hyprland {
	socket: PathBuf,
}

#[derive(Debug, Deserialize)]
struct Workspace {
	id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Client {
	address:          String,
	mapped:           bool,
	hidden:           bool,
	at:               [i32; 2],
	size:             [i32; 2],
	workspace:        Workspace,
	pid:              i64,
	#[serde(default)]
	class:            String,
	#[serde(default)]
	title:            String,
	#[serde(rename = "focusHistoryID")]
	focus_history_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Monitor {
	active_workspace:  Workspace,
	special_workspace: Workspace,
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
		(peer_pid(&stream) == Some(pid)).then_some(Self { socket })
	}

	fn request(&self, command: &str) -> CoreResult<Vec<u8>> {
		let failed = |err: std::io::Error| DesktopError::ax_failed(format!("Hyprland IPC: {err}"));
		let mut stream = UnixStream::connect(&self.socket).map_err(failed)?;
		stream.set_read_timeout(Some(IPC_TIMEOUT)).map_err(failed)?;
		stream.set_write_timeout(Some(IPC_TIMEOUT)).map_err(failed)?;
		stream.write_all(command.as_bytes()).map_err(failed)?;
		let mut reply = Vec::new();
		stream.read_to_end(&mut reply).map_err(failed)?;
		Ok(reply)
	}

	fn json<T: for<'de> Deserialize<'de>>(&self, command: &str) -> CoreResult<T> {
		serde_json::from_slice(&self.request(command)?)
			.map_err(|err| DesktopError::ax_failed(format!("Hyprland IPC {command}: {err}")))
	}

	/// Every mapped client, with whether a monitor shows its workspace.
	pub(super) fn list(&self) -> CoreResult<Vec<HyprlandWindow>> {
		let clients: Vec<Client> = self.json("j/clients")?;
		let monitors: Vec<Monitor> = self.json("j/monitors")?;
		Ok(clients
			.into_iter()
			.filter(|client| client.mapped && client.size[0] > 0 && client.size[1] > 0)
			.map(|client| {
				let visible = !client.hidden
					&& monitors.iter().any(|monitor| {
						monitor.active_workspace.id == client.workspace.id
							|| (monitor.special_workspace.id != 0
								&& monitor.special_workspace.id == client.workspace.id)
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
						focused: client.focus_history_id == 0,
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

	fn geometry(&self, id: &str) -> Option<NativeGeometry> {
		let address = id.strip_prefix(ID_PREFIX)?;
		let clients: Vec<Client> = self.json("j/clients").ok()?;
		let client = clients
			.into_iter()
			.find(|client| client.address == address && client.mapped && !client.hidden)?;
		Some(NativeGeometry {
			x:      client.at[0],
			y:      client.at[1],
			width:  u32::try_from(client.size[0]).ok()?,
			height: u32::try_from(client.size[1]).ok()?,
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
	use super::*;

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
		assert_eq!(client_for_frame(&windows, None, "Editor"), None);
	}

	#[test]
	fn the_client_list_parses_hyprland_json() {
		let clients: Vec<Client> = serde_json::from_str(
			r#"[{"address":"0x55f6","mapped":true,"hidden":false,"at":[647,38],"size":[621,750],
			"workspace":{"id":1,"name":"1"},"floating":false,"monitor":0,"class":"tgtk.py","title":"TGTK",
			"initialClass":"tgtk.py","initialTitle":"TGTK","pid":5754,"xwayland":false,"pinned":false,
			"fullscreen":0,"fullscreenClient":0,"grouped":[],"tags":[],"swallowing":"0x0",
			"focusHistoryID":1,"inhibitingIdle":false}]"#,
		)
		.unwrap();
		assert_eq!(clients[0].at, [647, 38]);
		assert_eq!(clients[0].pid, 5754);
		assert_eq!(clients[0].focus_history_id, 1);
	}
}
