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
	types::{DesktopDisplay, DesktopWindow},
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
	#[serde(default)]
	floating:         bool,
	#[serde(default)]
	pinned:           bool,
	/// A fullscreen mode number (0 when not fullscreen); a bool before 0.42.
	#[serde(default)]
	fullscreen:       serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Monitor {
	active_workspace:  Workspace,
	special_workspace: Workspace,
	#[serde(default)]
	x:                 i32,
	#[serde(default)]
	y:                 i32,
	/// The mode's pixel size, before `transform`.
	#[serde(default)]
	width:             u32,
	#[serde(default)]
	height:            u32,
	#[serde(default)]
	scale:             f64,
	/// `wl_output` transform: odd values turn the monitor a quarter.
	#[serde(default)]
	transform:         u32,
	#[serde(default)]
	disabled:          bool,
}

/// A monitor's place in Hyprland's logical layout and its pixel size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct MonitorGeometry {
	x:            i32,
	y:            i32,
	width:        f64,
	height:       f64,
	pixel_width:  u32,
	pixel_height: u32,
}

impl MonitorGeometry {
	fn of(monitor: &Monitor) -> Self {
		let (pixel_width, pixel_height) = if monitor.transform % 2 == 1 {
			(monitor.height, monitor.width)
		} else {
			(monitor.width, monitor.height)
		};
		let scale = if monitor.scale > 0.0 { monitor.scale } else { 1.0 };
		Self {
			x: monitor.x,
			y: monitor.y,
			width: f64::from(pixel_width) / scale,
			height: f64::from(pixel_height) / scale,
			pixel_width,
			pixel_height,
		}
	}

	/// Whether this monitor is `display` as a portal capture recorded it:
	/// the same logical place and size (within the portal's integer
	/// rounding) and the same pixel size.
	pub(super) fn shows(&self, display: &DesktopDisplay) -> bool {
		self.x == display.x
			&& self.y == display.y
			&& (self.width - f64::from(display.width)).abs() <= 1.0
			&& (self.height - f64::from(display.height)).abs() <= 1.0
			&& self.pixel_width == display.pixel_width
			&& self.pixel_height == display.pixel_height
	}
}

/// One Hyprland client as OMP lists it.
pub(super) struct HyprlandWindow {
	pub window:     DesktopWindow,
	/// On a workspace some monitor shows, so a screen capture shows it there.
	pub visible:    bool,
	pub workspace:  i64,
	pub floating:   bool,
	/// Floating and shown on every workspace.
	pub pinned:     bool,
	pub fullscreen: bool,
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

	/// Every enabled monitor's geometry.
	pub(super) fn monitors(&self) -> CoreResult<Vec<MonitorGeometry>> {
		let monitors: Vec<Monitor> = self.json("j/monitors")?;
		Ok(monitors
			.iter()
			.filter(|monitor| !monitor.disabled)
			.map(MonitorGeometry::of)
			.collect())
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
					workspace: client.workspace.id,
					floating: client.floating,
					pinned: client.pinned,
					fullscreen: match &client.fullscreen {
						serde_json::Value::Bool(on) => *on,
						serde_json::Value::Number(mode) => mode.as_i64().is_some_and(|mode| mode != 0),
						_ => false,
					},
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

/// The clients over part of `target` on screen, each with whether it is
/// certainly above it. Hyprland draws floating, pinned and fullscreen windows
/// over tiled ones, but does not report the order among floating windows (or
/// among overlapping tiled ones), so those are only possibly above.
pub(super) fn covering<'a>(
	clients: &'a [HyprlandWindow],
	target: &HyprlandWindow,
) -> Vec<(&'a HyprlandWindow, bool)> {
	let over = |client: &HyprlandWindow| -> Option<bool> {
		if client.fullscreen != target.fullscreen {
			return client.fullscreen.then_some(true);
		}
		match (client.floating || client.pinned, target.floating || target.pinned) {
			(true, false) => Some(true),
			(false, true) => None,
			_ => Some(false),
		}
	};
	clients
		.iter()
		.filter(|client| {
			client.window.id != target.window.id
				&& client.visible
				&& (client.workspace == target.workspace || client.pinned)
				&& overlap(&client.window, &target.window).is_some()
		})
		.filter_map(|client| over(client).map(|certain| (client, certain)))
		.collect()
}

/// The part of `target` that `other` covers, in `target`'s own logical
/// coordinates: `(x, y, width, height)`.
pub(super) fn overlap(other: &DesktopWindow, target: &DesktopWindow) -> Option<(i32, i32, u32, u32)> {
	let right = |window: &DesktopWindow| window.x.saturating_add(window.width as i32);
	let bottom = |window: &DesktopWindow| window.y.saturating_add(window.height as i32);
	let left = other.x.max(target.x);
	let top = other.y.max(target.y);
	let width = right(other).min(right(target)) - left;
	let height = bottom(other).min(bottom(target)) - top;
	(width > 0 && height > 0).then(|| (left - target.x, top - target.y, width as u32, height as u32))
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
		assert!(client_for_frame(&windows, None, "Editor").is_none());
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

	fn client(id: &str, at: (i32, i32, u32, u32), floating: bool, workspace: i64) -> HyprlandWindow {
		HyprlandWindow {
			window: DesktopWindow { x: at.0, y: at.1, width: at.2, height: at.3, ..window(id, 1, id) },
			visible: true,
			workspace,
			floating,
			pinned: false,
			fullscreen: false,
		}
	}

	#[test]
	fn a_floating_window_over_a_tiled_one_covers_it_and_floating_order_stays_open() {
		let tiled = client("hyprland:0x1", (12, 38, 600, 400), false, 1);
		let clients = [
			client("hyprland:0x1", (12, 38, 600, 400), false, 1),
			client("hyprland:0x2", (100, 100, 200, 100), true, 1),
			client("hyprland:0x3", (620, 38, 600, 400), false, 1),
			client("hyprland:0x4", (100, 100, 200, 100), true, 2),
		];
		let covers: Vec<_> = covering(&clients, &tiled)
			.into_iter()
			.map(|(client, above)| (client.window.id.as_str(), above))
			.collect();
		assert_eq!(covers, [("hyprland:0x2", true)]);
		// The floating window itself sits above every tiled one.
		assert!(covering(&clients, &clients[1]).is_empty());
		let floats = [client("hyprland:0x5", (0, 0, 300, 300), true, 1), client("hyprland:0x6", (50, 50, 300, 300), true, 1)];
		let covers = covering(&floats, &floats[0]);
		assert_eq!(covers.len(), 1);
		assert!(!covers[0].1, "two floating windows' order is unknown");
		assert_eq!(overlap(&clients[1].window, &tiled.window), Some((88, 62, 200, 100)));
		assert_eq!(overlap(&clients[2].window, &tiled.window), None);
	}

	#[test]
	fn a_monitor_matches_the_portal_display_it_was_captured_as() {
		let monitor = |width, height, scale, transform| Monitor {
			active_workspace: Workspace { id: 1 },
			special_workspace: Workspace { id: 0 },
			x: 0,
			y: 0,
			width,
			height,
			scale,
			transform,
			disabled: false,
		};
		let display = |width, height, pixel_width, pixel_height| DesktopDisplay {
			id: "wayland-portal-0".to_owned(),
			name: String::new(),
			x: 0,
			y: 0,
			width,
			height,
			scale: f64::from(pixel_width) / f64::from(width),
			pixel_x: 0,
			pixel_y: 0,
			pixel_width,
			pixel_height,
			is_primary: true,
		};
		assert!(MonitorGeometry::of(&monitor(1280, 800, 1.0, 0)).shows(&display(1280, 800, 1280, 800)));
		assert!(MonitorGeometry::of(&monitor(2560, 1600, 1.25, 0)).shows(&display(2048, 1280, 2560, 1600)));
		assert!(MonitorGeometry::of(&monitor(1280, 800, 1.0, 1)).shows(&display(800, 1280, 800, 1280)));
		assert!(!MonitorGeometry::of(&monitor(1920, 1080, 1.0, 0)).shows(&display(1280, 800, 1280, 800)));
		assert!(!MonitorGeometry::of(&monitor(2560, 1600, 2.0, 0)).shows(&display(2048, 1280, 2560, 1600)));
	}
}
