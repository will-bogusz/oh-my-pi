use std::time::Duration;

use atspi::{
	CoordType, ObjectRefOwned, Role, State,
	proxy::{
		accessible::{AccessibleProxy, ObjectRefExt},
		bus::BusProxy,
	},
	zbus::{Connection, proxy::CacheProperties},
};
use tokio::runtime::{Builder, Runtime};

use crate::desktop::{
	ax::{AxBounds, AxHandle, AxProps, normalize_role_atspi},
	backend::AxBackend,
	control::cancellable,
	error::{CoreResult, DesktopError, ErrorCode},
	types::DesktopWindow,
};

mod menus;

/// How long an application gets to answer before it counts as not answering:
/// one request reads one element (about a dozen calls) or walks a short chain
/// of its parents or children, and a read of a whole application or menu
/// bounds each call instead. libatspi gives each call 800 ms; a text edit in
/// an office suite can take 2 s.
///
/// at-spi2-core's ATK bridge (GTK 3 apps) replies to `DoAction` before it runs
/// the action inside its D-Bus dispatch, so an action that opens a modal
/// dialog leaves the app answering no request until that dialog closes.
const REPLY_TIMEOUT: Duration = Duration::from_secs(5);

pub struct AtSpiAx {
	rt:            Runtime,
	connection:    Connection,
	/// [`REPLY_TIMEOUT`] outside tests.
	reply_timeout: Duration,
}

fn unanswered(who: &str, within: Duration) -> DesktopError {
	DesktopError::timeout(format!(
		"AT-SPI: {who} did not answer within {} s. An app answers no accessibility request while it \
		 is busy, and a GTK 3 app none while a modal dialog that an accessibility action (press, \
		 menu select) opened is up; use screenshots and pointer or key input until it answers again",
		within.as_secs_f64()
	))
}

/// The error for a lookup that missed what an application that did not answer
/// [`AtSpiAx::windows`] holds.
pub(crate) fn not_answering() -> DesktopError {
	unanswered("the application", REPLY_TIMEOUT)
}

/// `error`, saying that an action or value the application did not confirm
/// may still take effect.
fn unconfirmed(mut error: DesktopError) -> DesktopError {
	if error.code == ErrorCode::Timeout {
		error
			.message
			.push_str(". What was sent to it may still take effect when it answers");
	}
	error
}

/// `future`, or [`unanswered`] once it has waited `within`.
async fn answered<T>(
	who: &str,
	within: Duration,
	future: impl Future<Output = T>,
) -> CoreResult<T> {
	tokio::time::timeout(within, future)
		.await
		.map_err(|_| unanswered(who, within))
}

/// The windows of the applications that answered, and the bus names of those
/// that did not.
pub struct AtSpiWindows {
	pub windows:    Vec<AtSpiWindow>,
	pub unanswered: Vec<String>,
}

/// An AT-SPI top-level frame and whether its reported screen position is real.
///
/// Native Wayland clients cannot learn where the compositor placed them, so
/// their toolkits answer `CoordType::Screen` with window-relative coordinates
/// (usually `0,0`). Consumers that map `window` bounds onto a desktop capture
/// (the Wayland window crop) must refuse when `position_known` is false.
pub struct AtSpiWindow {
	pub window:         DesktopWindow,
	/// Screen and window-relative origins differ, so `window.x`/`window.y` are
	/// global compositor coordinates. False also covers a window genuinely at
	/// the global origin, which is indistinguishable over AT-SPI.
	pub position_known: bool,
}

impl AtSpiAx {
	pub(crate) fn new() -> CoreResult<Self> {
		let rt = Builder::new_current_thread()
			.enable_all()
			.build()
			.map_err(|err| DesktopError::ax_failed(format!("AT-SPI runtime: {err}")))?;
		// Not `AccessibilityConnection::new`: it also asks every application for
		// a peer-to-peer address, so one application that does not answer
		// would hang every new session and menu command.
		let connection = rt
			.block_on(async {
				let session = Connection::session().await?;
				let address = BusProxy::new(&session).await?.get_address().await?;
				atspi::zbus::connection::Builder::address(address.as_str())?
					.build()
					.await
			})
			.map_err(|err| DesktopError::ax_failed(format!("AT-SPI connection: {err}")))?;
		Ok(Self { rt, connection, reply_timeout: REPLY_TIMEOUT })
	}

	/// Runs `future` until it finishes or the current operation is cancelled,
	/// so a call no application answers never holds the desktop worker past
	/// the run that made it.
	fn run<T>(&self, future: impl Future<Output = T>) -> CoreResult<T> {
		self.rt.block_on(cancellable(future))
	}

	/// [`Self::run`] for a request to one application, which fails once that
	/// application has not answered within the reply timeout.
	fn request<T>(&self, future: impl Future<Output = CoreResult<T>>) -> CoreResult<T> {
		self.run(answered("the application", self.reply_timeout, future))??
	}

	/// One call to an application, bounded on its own: for reads of a whole
	/// application or menu, which can take longer than one reply may.
	async fn reply<T>(&self, call: impl Future<Output = T>) -> CoreResult<T> {
		answered("the application", self.reply_timeout, call).await
	}

	const fn object(h: &AxHandle) -> &ObjectRefOwned {
		match h {
			AxHandle::AtSpi(object) => object,
			#[cfg(test)]
			_ => panic!("AT-SPI backend received a non-AT-SPI handle"),
		}
	}

	pub(crate) fn windows(&self) -> CoreResult<AtSpiWindows> {
		self.run(async {
			let mut listed = AtSpiWindows { windows: Vec::new(), unanswered: Vec::new() };
			for app in Self::apps(&self.connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				// The windows of an application that does not answer are left
				// out rather than holding back every other application's.
				let limit = 48 - listed.windows.len();
				let Ok(windows) =
					answered("the application", self.reply_timeout, self.app_windows(&app, limit)).await
				else {
					listed
						.unanswered
						.extend(app.name().map(ToString::to_string));
					continue;
				};
				listed.windows.extend(windows?);
				if listed.windows.len() == 48 {
					break;
				}
			}
			Ok(listed)
		})?
	}

	async fn app_windows(&self, app: &ObjectRefOwned, limit: usize) -> CoreResult<Vec<AtSpiWindow>> {
		let mut windows = Vec::new();
		let app_proxy = app
			.as_accessible_proxy(&self.connection)
			.await
			.map_err(|err| DesktopError::ax_failed(format!("AT-SPI application: {err}")))?;
		let app_name = app_proxy.name().await.unwrap_or_default();
		let pid = if let Some(bus_name) = app.name() {
			let dbus = atspi::zbus::fdo::DBusProxy::new(&self.connection)
				.await
				.ok();
			if let Some(dbus) = dbus {
				dbus
					.get_connection_unix_process_id(bus_name.clone().into())
					.await
					.ok()
			} else {
				None
			}
		} else {
			None
		};
		for frame in Self::frames(&self.connection, app)
			.await
			.unwrap_or_default()
		{
			let frame_proxy = frame
				.as_accessible_proxy(&self.connection)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI frame: {err}")))?;
			let title = frame_proxy.name().await.unwrap_or_default();
			let state = frame_proxy.get_state().await.ok();
			let Ok(component) = Self::component(&self.connection, &frame).await else {
				continue;
			};
			let Ok((x, y, width, height)) = component.get_extents(CoordType::Screen).await else {
				continue;
			};
			if width < 16 || height < 16 {
				continue;
			}
			let position_known = component
				.get_extents(CoordType::Window)
				.await
				.is_ok_and(|(window_x, window_y, ..)| (window_x, window_y) != (x, y));
			let id = atspi_window_id(&frame);
			windows.push(AtSpiWindow {
				window: DesktopWindow {
					id,
					title,
					app: app_name.clone(),
					pid,
					x,
					y,
					width: width as u32,
					height: height as u32,
					focused: state.as_ref().is_some_and(|states| {
						states.contains(State::Focused) || states.contains(State::Active)
					}),
				},
				position_known,
			});
			if windows.len() == limit {
				break;
			}
		}
		Ok(windows)
	}

	async fn apps(connection: &Connection) -> Result<Vec<ObjectRefOwned>, String> {
		// The registry implements too little of the D-Bus properties interface
		// to cache its properties.
		let root = AccessibleProxy::builder(connection)
			.destination("org.a11y.atspi.Registry")
			.map_err(|err| err.to_string())?
			.cache_properties(CacheProperties::No)
			.build()
			.await
			.map_err(|err| err.to_string())?;
		root.get_children().await.map_err(|err| err.to_string())
	}

	async fn app_for_window(&self, win: &DesktopWindow) -> CoreResult<ObjectRefOwned> {
		let failed = |err: String| DesktopError::ax_failed(format!("AT-SPI window root: {err}"));
		let apps = Self::apps(&self.connection).await.map_err(failed)?;
		let mut matches = Vec::new();
		let mut unanswered_apps = false;
		for app in apps {
			if win.id.starts_with("atspi:") {
				if app
					.name()
					.is_some_and(|name| win.id.starts_with(&format!("atspi:{name}:")))
				{
					matches.push(app);
				}
				continue;
			}
			// The bus names an application's process without asking it.
			if let Some(pid) = win.pid {
				let Some(bus_name) = app.name() else {
					continue;
				};
				let dbus = atspi::zbus::fdo::DBusProxy::new(&self.connection)
					.await
					.map_err(|err| failed(err.to_string()))?;
				if dbus
					.get_connection_unix_process_id(bus_name.clone().into())
					.await
					.ok()
					== Some(pid)
				{
					matches.push(app);
				}
				continue;
			}
			let proxy = app
				.as_accessible_proxy(&self.connection)
				.await
				.map_err(|err| failed(err.to_string()))?;
			match answered("the application", self.reply_timeout, proxy.name()).await {
				Ok(name)
					if name
						.as_deref()
						.unwrap_or_default()
						.eq_ignore_ascii_case(&win.app) =>
				{
					matches.push(app.clone());
				},
				Ok(_) => {},
				Err(_) => unanswered_apps = true,
			}
		}
		// Without a process, an application that did not answer may be the
		// named one, or another of that name.
		if unanswered_apps {
			return Err(unanswered("an application", self.reply_timeout));
		}
		if matches.len() == 1 {
			Ok(matches.remove(0))
		} else {
			Err(failed(format!(
				"application '{}' (pid {:?}) has {} AT-SPI matches; refusing ambiguous ownership",
				win.app,
				win.pid,
				matches.len()
			)))
		}
	}

	async fn frames(
		connection: &Connection,
		app: &ObjectRefOwned,
	) -> Result<Vec<ObjectRefOwned>, String> {
		let proxy = app
			.as_accessible_proxy(connection)
			.await
			.map_err(|err| err.to_string())?;
		let children = proxy.get_children().await.map_err(|err| err.to_string())?;
		let mut frames = Vec::new();
		for child in children {
			let child_proxy = child
				.as_accessible_proxy(connection)
				.await
				.map_err(|err| err.to_string())?;
			if matches!(child_proxy.get_role().await, Ok(Role::Frame | Role::Dialog | Role::Window)) {
				frames.push(child);
			}
		}
		Ok(frames)
	}

	/// `app`'s frames that contain the screen point `(x, y)`.
	async fn frames_at(
		connection: &Connection,
		app: &ObjectRefOwned,
		x: i32,
		y: i32,
	) -> CoreResult<Vec<ObjectRefOwned>> {
		let mut containing = Vec::new();
		for frame in Self::frames(connection, app)
			.await
			.map_err(DesktopError::ax_failed)?
		{
			let component = Self::component(connection, &frame)
				.await
				.map_err(DesktopError::ax_failed)?;
			if component
				.contains(x, y, CoordType::Screen)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI frame hit test: {err}")))?
			{
				containing.push(frame);
			}
		}
		Ok(containing)
	}

	async fn component<'a>(
		connection: &'a Connection,
		object: &'a ObjectRefOwned,
	) -> Result<atspi::proxy::component::ComponentProxy<'a>, String> {
		let name = object
			.name()
			.ok_or_else(|| "AT-SPI object has no bus name".to_string())?
			.clone();
		atspi::proxy::component::ComponentProxy::builder(connection)
			.destination(name)
			.map_err(|err| err.to_string())?
			.path(object.path().clone())
			.map_err(|err| err.to_string())?
			.build()
			.await
			.map_err(|err| err.to_string())
	}

	/// `object`'s `Action` proxy, without zbus's property cache: the cache
	/// reads properties with `GetAll`, which Qt refuses, so `NActions` would
	/// fail on every Qt element.
	async fn action<'a>(
		connection: &'a Connection,
		object: &'a ObjectRefOwned,
	) -> Result<atspi::proxy::action::ActionProxy<'a>, String> {
		let name = object
			.name()
			.ok_or_else(|| "AT-SPI object has no bus name".to_string())?
			.clone();
		atspi::proxy::action::ActionProxy::builder(connection)
			.destination(name)
			.map_err(|err| err.to_string())?
			.path(object.path().clone())
			.map_err(|err| err.to_string())?
			.cache_properties(atspi::zbus::proxy::CacheProperties::No)
			.build()
			.await
			.map_err(|err| err.to_string())
	}

	/// Each call has its own reply timeout: reading a whole application can
	/// take longer than one reply may.
	async fn find_focused(
		connection: &Connection,
		root: ObjectRefOwned,
		depth: u8,
		reply_timeout: Duration,
	) -> CoreResult<Option<ObjectRefOwned>> {
		// Chromium/Electron frames report children that are the AT-SPI null
		// object.
		if depth > 40 || root.is_null() {
			return Ok(None);
		}
		let proxy = root
			.as_accessible_proxy(connection)
			.await
			.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
		if answered("the application", reply_timeout, proxy.get_state())
			.await?
			.is_ok_and(|state| state.contains(State::Focused))
		{
			return Ok(Some(root));
		}
		for child in answered("the application", reply_timeout, proxy.get_children())
			.await?
			.unwrap_or_default()
		{
			if let Some(found) =
				Box::pin(Self::find_focused(connection, child, depth + 1, reply_timeout)).await?
			{
				return Ok(Some(found));
			}
		}
		Ok(None)
	}
}

fn atspi_window_id(frame: &ObjectRefOwned) -> String {
	let name = frame.name().map_or_default(ToString::to_string);
	format!("atspi:{name}:{}", frame.path())
}

fn native_window_for_frame(windows: &[DesktopWindow], pid: u32, title: &str) -> CoreResult<String> {
	let mut matches = windows.iter().filter(|window| {
		!window.id.starts_with("atspi:") && window.pid == Some(pid) && window.title == title
	});
	let first = matches.next().ok_or_else(|| {
		DesktopError::window_not_found("AT-SPI frame has no matching native window")
	})?;
	if matches.next().is_some() {
		return Err(DesktopError::ax_failed(
			"AT-SPI frame matches multiple native windows; refusing ambiguous input ownership",
		));
	}
	Ok(first.id.clone())
}

/// Generic press means activation, not action zero (GTK4 text views put
/// `buffer.delete-line` there). Explicit advertised actions remain available.
fn action_index<'a>(
	mut actions: impl Iterator<Item = &'a str> + Clone,
	requested: &str,
) -> Option<usize> {
	actions
		.clone()
		.position(|name| name.eq_ignore_ascii_case(requested))
		.or_else(|| {
			requested
				.eq_ignore_ascii_case("press")
				.then(|| {
					actions.position(|name| {
						[
							"click",
							"clickAncestor",
							"activate",
							"invoke",
							"toggle",
							"open",
							"jump",
							"do default",
							"do-default",
						]
						.iter()
						.any(|safe| name.eq_ignore_ascii_case(safe))
					})
				})
				.flatten()
		})
}

/// The most actions read of one element: the count comes from the app.
const MAX_ACTIONS: i32 = 256;

/// The machine names of an element's actions, by index (`press`, `click`,
/// `activate`): what libatspi's `atspi_action_get_action_name` reads.
/// `GetActions` returns localized names instead: Firefox reports each as `;;`,
/// Chromium, Electron and the GTK3 build of `LibreOffice` as empty strings, and
/// every toolkit translates them under a non-English locale.
async fn action_names(
	proxy: &atspi::proxy::action::ActionProxy<'_>,
) -> atspi::zbus::Result<Vec<String>> {
	let count = proxy.n_actions().await?.clamp(0, MAX_ACTIONS);
	futures::future::try_join_all((0..count).map(|index| proxy.get_name(index))).await
}

/// The index of `action` among `proxy`'s actions, matched by machine name. A
/// generic press of a checkbox or toggle button falls back on `check` or
/// `uncheck`, the only activation Chromium and Electron give them.
async fn resolve_action(
	proxy: &atspi::proxy::action::ActionProxy<'_>,
	accessible: &atspi::proxy::accessible::AccessibleProxy<'_>,
	action: &str,
) -> CoreResult<i32> {
	let names = action_names(proxy)
		.await
		.map_err(|err| DesktopError::ax_failed(format!("AT-SPI actions: {err}")))?;
	let names = || names.iter().map(String::as_str);
	let mut index = action_index(names(), action);
	if index.is_none()
		&& action.eq_ignore_ascii_case("press")
		&& matches!(
			accessible.get_role().await,
			Ok(Role::CheckBox | Role::CheckMenuItem | Role::ToggleButton)
		) {
		index = names().position(|name| {
			name.eq_ignore_ascii_case("check") || name.eq_ignore_ascii_case("uncheck")
		});
	}
	let index = index
		.ok_or_else(|| DesktopError::ax_failed(format!("AT-SPI action '{action}' is unavailable")))?;
	i32::try_from(index).map_err(|err| DesktopError::ax_failed(err.to_string()))
}

impl AxBackend for AtSpiAx {
	fn window_root(&mut self, win: &DesktopWindow) -> CoreResult<AxHandle> {
		let failed = |err: String| DesktopError::ax_failed(format!("AT-SPI window root: {err}"));
		let who = if win.app.is_empty() {
			"the application"
		} else {
			win.app.as_str()
		};
		self
			.run(async {
				let app = self.app_for_window(win).await?;
				answered(who, self.reply_timeout, async {
					let frames = Self::frames(&self.connection, &app).await.map_err(failed)?;
					let mut matches = Vec::new();
					for frame in frames {
						let id = atspi_window_id(&frame);
						if win.id.starts_with("atspi:") {
							if id == win.id {
								return Ok(frame);
							}
							continue;
						}
						let proxy = frame
							.as_accessible_proxy(&self.connection)
							.await
							.map_err(|err| failed(err.to_string()))?;
						if proxy.name().await.map_err(|err| failed(err.to_string()))? == win.title {
							matches.push(frame);
						}
					}
					if matches.len() == 1 {
						Ok(matches.remove(0))
					} else {
						Err(failed(format!(
							"window '{}' has {} matching AT-SPI frames",
							win.title,
							matches.len()
						)))
					}
				})
				.await?
			})?
			.map(AxHandle::AtSpi)
	}

	fn window_id(&mut self, h: &AxHandle, windows: &[DesktopWindow]) -> CoreResult<String> {
		let mut object = Self::object(h).clone();
		self.request(async {
			// Follow ownership, never screen containment: overlapping windows and
			// same-process dialogs are distinct input destinations.
			for _ in 0..64 {
				let proxy = object
					.as_accessible_proxy(&self.connection)
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window owner: {err}")))?;
				let role = proxy
					.get_role()
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window role: {err}")))?;
				if matches!(role, Role::Frame | Role::Dialog | Role::Window) {
					let id = atspi_window_id(&object);
					if windows.iter().any(|window| window.id == id) {
						return Ok(id);
					}
					let name = object
						.name()
						.ok_or_else(|| DesktopError::ax_failed("AT-SPI window has no bus owner"))?;
					let dbus = atspi::zbus::fdo::DBusProxy::new(&self.connection)
						.await
						.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
					let pid = dbus
						.get_connection_unix_process_id(name.clone().into())
						.await
						.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window pid: {err}")))?;
					let title = proxy
						.name()
						.await
						.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window title: {err}")))?;
					return native_window_for_frame(windows, pid, &title);
				}
				let parent = proxy
					.parent()
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window parent: {err}")))?;
				if parent.is_null() || parent == object {
					break;
				}
				drop(proxy);
				object = parent;
			}
			Err(DesktopError::ax_failed("AT-SPI element has no identifiable top-level window"))
		})
	}

	fn props(&mut self, h: &AxHandle) -> CoreResult<AxProps> {
		let object = Self::object(h).clone();
		self.request(async {
			let proxy = object
				.as_accessible_proxy(&self.connection)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI accessible: {err}")))?;
			let title = proxy.name().await.ok().filter(|s| !s.is_empty());
			let description = proxy.description().await.ok().filter(|s| !s.is_empty());
			let native_role = match proxy.get_role_name().await {
				Ok(role) => role,
				Err(_) => proxy
					.get_localized_role_name()
					.await
					.unwrap_or_else(|_| "unknown".to_string()),
			};
			let state = proxy.get_state().await.ok();
			let multiline = state
				.as_ref()
				.is_some_and(|states| states.contains(State::MultiLine));
			let value = if let Some(name) = object.name().cloned() {
				let builder = atspi::proxy::text::TextProxy::builder(&self.connection)
					.destination(name)
					.and_then(|builder| builder.path(object.path().clone()));
				if let Ok(builder) = builder
					&& let Ok(text) = builder.build().await
				{
					let count = text.character_count().await.unwrap_or(0).min(16_384);
					text.get_text(0, count).await.ok().filter(|s| !s.is_empty())
				} else {
					None
				}
			} else {
				None
			};
			let bounds = if let Ok(component) = Self::component(&self.connection, &object).await {
				component
					.get_extents(CoordType::Screen)
					.await
					.ok()
					.and_then(|(x, y, width, height)| {
						(width >= 0 && height >= 0).then_some(AxBounds {
							x:      f64::from(x),
							y:      f64::from(y),
							width:  f64::from(width),
							height: f64::from(height),
						})
					})
			} else {
				None
			};
			let actions = match Self::action(&self.connection, &object).await {
				Ok(action) => action_names(&action).await.unwrap_or_default(),
				Err(_) => Vec::new(),
			};
			let child_count = proxy.child_count().await.unwrap_or(0).max(0) as u32;
			Ok(AxProps {
				role: normalize_role_atspi(&native_role, multiline),
				native_role,
				title,
				value,
				description,
				enabled: state
					.as_ref()
					.is_some_and(|states| states.contains(State::Enabled)),
				focused: state
					.as_ref()
					.is_some_and(|states| states.contains(State::Focused)),
				bounds,
				actions,
				child_count,
				identity: None,
				partial: false,
			})
		})
	}

	fn children(&mut self, h: &AxHandle) -> CoreResult<Vec<AxHandle>> {
		let object = Self::object(h).clone();
		self.request(async {
			let proxy = object
				.as_accessible_proxy(&self.connection)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI children: {err}")))?;
			proxy
				.get_children()
				.await
				.map(|items| {
					items
						.into_iter()
						.filter(|item| !item.is_null())
						.map(AxHandle::AtSpi)
						.collect()
				})
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI children: {err}")))
		})
	}

	fn parent(&mut self, h: &AxHandle) -> CoreResult<Option<AxHandle>> {
		let object = Self::object(h).clone();
		self.request(async {
			let proxy = object
				.as_accessible_proxy(&self.connection)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI parent: {err}")))?;
			let parent = proxy
				.parent()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI parent: {err}")))?;
			Ok((!parent.is_null()).then_some(AxHandle::AtSpi(parent)))
		})
	}

	fn perform(&mut self, h: &AxHandle, action: &str) -> CoreResult<()> {
		let object = Self::object(h).clone();
		self
			.request(async {
				let proxy = Self::action(&self.connection, &object)
					.await
					.map_err(DesktopError::ax_failed)?;
				let accessible = object
					.as_accessible_proxy(&self.connection)
					.await
					.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
				let index = resolve_action(&proxy, &accessible, action).await?;
				proxy
					.do_action(index)
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI action: {err}")))?
					.ok_or_else(|| DesktopError::ax_failed(format!("AT-SPI action '{action}' failed")))
			})
			.map_err(unconfirmed)
	}

	fn set_value(&mut self, h: &AxHandle, value: &str) -> CoreResult<()> {
		let object = Self::object(h).clone();
		self
			.request(async {
				let name = object
					.name()
					.ok_or_else(|| DesktopError::ax_failed("AT-SPI object has no bus name"))?
					.clone();
				let accessible = object
					.as_accessible_proxy(&self.connection)
					.await
					.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
				let interfaces = accessible
					.get_interfaces()
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI interfaces: {err}")))?;
				if interfaces.contains(atspi::Interface::EditableText) {
					let editable =
						atspi::proxy::editable_text::EditableTextProxy::builder(&self.connection)
							.destination(name.clone())
							.and_then(|b| b.path(object.path().clone()))
							.map_err(|err| DesktopError::ax_failed(err.to_string()))?
							.build()
							.await;
					let editable = editable
						.map_err(|err| DesktopError::ax_failed(format!("AT-SPI editable text: {err}")))?;
					return editable
						.set_text_contents(value)
						.await
						.map_err(|err| DesktopError::ax_failed(format!("AT-SPI text value: {err}")))?
						.ok_or_else(|| DesktopError::ax_failed("AT-SPI text value was rejected"));
				}
				if !interfaces.contains(atspi::Interface::Value) {
					return Err(DesktopError::ax_failed(
						"AT-SPI element has no writable value interface",
					));
				}
				let numeric = value.parse::<f64>().map_err(|_| {
					DesktopError::ax_failed("AT-SPI value is not editable text or a number")
				})?;
				if !numeric.is_finite() {
					return Err(DesktopError::ax_failed("AT-SPI numeric value must be finite"));
				}
				let proxy = atspi::proxy::value::ValueProxy::builder(&self.connection)
					.destination(name)
					.and_then(|b| b.path(object.path().clone()))
					.map_err(|err| DesktopError::ax_failed(err.to_string()))?
					.build()
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI value: {err}")))?;
				proxy
					.set_current_value(numeric)
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI value: {err}")))
			})
			.map_err(unconfirmed)
	}

	fn focus(&mut self, h: &AxHandle) -> CoreResult<()> {
		let object = Self::object(h).clone();
		self
			.request(async {
				let component = Self::component(&self.connection, &object)
					.await
					.map_err(DesktopError::ax_failed)?;
				component
					.grab_focus()
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI focus: {err}")))?
					.ok_or_else(|| DesktopError::ax_failed("AT-SPI focus request was rejected"))
			})
			.map_err(unconfirmed)
	}

	fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>> {
		let x = x.round() as i32;
		let y = y.round() as i32;
		self.run(async {
			let mut root = None;
			for app in Self::apps(&self.connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				// An application that does not answer may own the point, so no
				// other application's frame is known to be on top.
				let frames = answered(
					"an application",
					self.reply_timeout,
					Self::frames_at(&self.connection, &app, x, y),
				)
				.await??;
				for frame in frames {
					// AT-SPI enumeration is not stacking order. Never choose an
					// arbitrary frame when two top-levels contain the point.
					if let Some(previous) = &root {
						if previous != &frame {
							return Err(DesktopError::ax_failed(
								"multiple AT-SPI windows contain this point; topmost ownership is \
								 ambiguous",
							));
						}
					} else {
						root = Some(frame);
					}
				}
			}
			let Some(root) = root else {
				return Ok(None);
			};
			answered("the application", self.reply_timeout, async {
				let mut current = root;
				let mut ancestors = Vec::new();
				for _ in 0..64 {
					let has_component = {
						let accessible = current
							.as_accessible_proxy(&self.connection)
							.await
							.map_err(|err| {
								DesktopError::ax_failed(format!("AT-SPI hit-test element: {err}"))
							})?;
						accessible
							.get_interfaces()
							.await
							.map_err(|err| {
								DesktopError::ax_failed(format!("AT-SPI hit-test interfaces: {err}"))
							})?
							.contains(atspi::Interface::Component)
					};
					if !has_component {
						return Ok(Some(AxHandle::AtSpi(current)));
					}
					// GetAccessibleAtPoint returns an immediate child, not
					// necessarily the leaf that owns the requested pixel.
					let child = {
						let component = Self::component(&self.connection, &current)
							.await
							.map_err(DesktopError::ax_failed)?;
						component
							.get_accessible_at_point(x, y, CoordType::Screen)
							.await
							.map_err(|err| {
								DesktopError::ax_failed(format!("AT-SPI element at point: {err}"))
							})?
					};
					if child.is_null() || child == current {
						return Ok(Some(AxHandle::AtSpi(current)));
					}
					if ancestors.contains(&child) {
						return Err(DesktopError::ax_failed(
							"AT-SPI hit-test hierarchy contains a cycle",
						));
					}
					ancestors.push(current);
					current = child;
				}
				Err(DesktopError::ax_failed("AT-SPI hit-test hierarchy exceeds the depth limit"))
			})
			.await?
		})?
	}

	fn focused_element(&mut self) -> CoreResult<Option<AxHandle>> {
		self.run(async {
			let mut unanswered_app = false;
			for app in Self::apps(&self.connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				match Self::find_focused(&self.connection, app, 0, self.reply_timeout).await {
					Ok(Some(found)) => return Ok(Some(AxHandle::AtSpi(found))),
					Ok(None) => {},
					// The focus may be in an application that does not answer,
					// which no other application's lack of focus rules out.
					Err(error) if error.code == ErrorCode::Timeout => unanswered_app = true,
					Err(error) => return Err(error),
				}
			}
			if unanswered_app {
				Err(unanswered("an application", self.reply_timeout))
			} else {
				Ok(None)
			}
		})?
	}

	fn attributes(&mut self, h: &AxHandle) -> CoreResult<Vec<(String, String)>> {
		let object = Self::object(h).clone();
		self.request(async {
			let proxy = object
				.as_accessible_proxy(&self.connection)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI attributes: {err}")))?;
			let mut attrs: Vec<_> = proxy
				.get_attributes()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI attributes: {err}")))?
				.into_iter()
				.map(|(key, mut value)| {
					value.truncate(200);
					(key, value)
				})
				.collect();
			attrs.sort_by(|a, b| a.0.cmp(&b.0));
			Ok(attrs)
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn generic_press_never_selects_an_unrelated_editing_action() {
		let actions = ["buffer.delete-line", "clipboard.cut", "activate"];
		assert_eq!(action_index(actions.into_iter(), "press"), Some(2));
		assert_eq!(action_index(actions[..2].iter().copied(), "press"), None);
		assert_eq!(action_index(actions.into_iter(), "buffer.delete-line"), Some(0));
		assert_eq!(action_index(std::iter::empty(), "press"), None);
	}

	#[test]
	fn frame_ownership_requires_unique_process_and_title() {
		let window = |id: &str, pid: u32| DesktopWindow {
			id:      id.to_owned(),
			pid:     Some(pid),
			title:   "Document".into(),
			app:     "Editor".into(),
			x:       0,
			y:       0,
			width:   100,
			height:  100,
			focused: false,
		};
		let mut windows = vec![window("1", 10), window("2", 20)];
		assert_eq!(native_window_for_frame(&windows, 20, "Document").unwrap(), "2");
		assert!(native_window_for_frame(&windows, 30, "Document").is_err());
		windows.push(window("3", 20));
		assert!(native_window_for_frame(&windows, 20, "Document").is_err());
	}

	#[test]
	fn focused_search_skips_null_child_refs() {
		use atspi::zbus::{
			connection::Builder as ConnectionBuilder, interface, zvariant::OwnedObjectPath,
		};

		/// Minimal `org.a11y.atspi.Accessible` node: a state set plus `(name,
		/// path)` children.
		struct Node {
			state:    Vec<u32>,
			children: Vec<(String, OwnedObjectPath)>,
		}

		#[interface(name = "org.a11y.atspi.Accessible")]
		impl Node {
			fn get_state(&self) -> Vec<u32> {
				self.state.clone()
			}

			fn get_children(&self) -> Vec<(String, OwnedObjectPath)> {
				self.children.clone()
			}
		}

		const PEER: &str = ":1.7";
		let path = |p: &str| OwnedObjectPath::try_from(p).unwrap();
		let focused = State::Focused as u64;
		let rt = Builder::new_current_thread().enable_all().build().unwrap();
		let found = rt.block_on(async {
			let (client, server) = tokio::net::UnixStream::pair().unwrap();
			let root = Node {
				state:    vec![0, 0],
				// Chromium frames report children that are all the AT-SPI null object.
				children: vec![
					(PEER.to_owned(), path("/org/a11y/atspi/null")),
					(PEER.to_owned(), path("/focus")),
				],
			};
			let leaf =
				Node { state: vec![focused as u32, (focused >> 32) as u32], children: Vec::new() };
			let guid = atspi::zbus::Guid::generate();
			let server = ConnectionBuilder::unix_stream(server)
				.server(guid)
				.unwrap()
				.p2p()
				.serve_at("/root", root)
				.unwrap()
				.serve_at("/focus", leaf)
				.unwrap()
				.build();
			let client = ConnectionBuilder::unix_stream(client).p2p().build();
			let (server, client) = tokio::try_join!(server, client).unwrap();
			let root = ObjectRefOwned::from_static_str_unchecked(PEER, "/root");
			let found = AtSpiAx::find_focused(&client, root, 0, REPLY_TIMEOUT).await;
			drop(server);
			found
		});
		let found = found.expect("null child refs must not fail the focused search");
		assert_eq!(
			found
				.map(|object| object.path_as_str().to_owned())
				.as_deref(),
			Some("/focus")
		);
	}

	#[test]
	fn actions_match_by_machine_name_not_localized_name() {
		use atspi::zbus::{
			MessageStream, connection::Builder as ConnectionBuilder, message::Type, zvariant::Value,
		};
		use futures::StreamExt;

		/// Path, localized names (`GetActions`), machine names (`GetName`),
		/// `NActions`, role, requested action and the index it must resolve to.
		type Case = (
			&'static str,
			&'static [&'static str],
			&'static [&'static str],
			i32,
			Role,
			&'static str,
			Option<i32>,
		);
		const CASES: [Case; 6] = [
			// Firefox.
			("/firefox", &[";;"], &["press"], 1, Role::Button, "press", Some(0)),
			// A GTK app under a German locale.
			("/german", &["Klicken"], &["click"], 1, Role::Button, "press", Some(0)),
			// Chromium's checkbox, and VS Code's Toggle Panel: a toggle button.
			(
				"/checkbox",
				&["", ""],
				&["uncheck", "showContextMenu"],
				2,
				Role::CheckBox,
				"press",
				Some(0),
			),
			(
				"/toggle",
				&["", ""],
				&["check", "showContextMenu"],
				2,
				Role::ToggleButton,
				"press",
				Some(0),
			),
			// No activation at all is still refused.
			("/menu_only", &["Show menu"], &["showMenu"], 1, Role::Button, "press", None),
			// An app reporting a nonsense count is read only up to the cap.
			("/huge", &[], &["press"], i32::MAX, Role::Button, "press", Some(0)),
		];
		const PEER: &str = ":1.7";

		/// Answers like the apps, `GetAll` refused as Qt refuses it, so a proxy
		/// that caches properties cannot read `NActions`.
		async fn app(server: atspi::zbus::Connection) {
			let mut stream = MessageStream::from(&server);
			while let Some(Ok(message)) = stream.next().await {
				if message.message_type() != Type::MethodCall {
					continue;
				}
				let header = message.header();
				let path = header.path().unwrap().to_string();
				let member = header.member().unwrap().to_string();
				let Some(case) = CASES.iter().find(|case| case.0 == path) else {
					server
						.reply_error(&header, "org.freedesktop.DBus.Error.UnknownObject", &"")
						.await
						.unwrap();
					continue;
				};
				match member.as_str() {
					"Get" => {
						let (_, property): (String, String) = message.body().deserialize().unwrap();
						assert_eq!(property, "NActions");
						server.reply(&header, &Value::from(case.3)).await.unwrap();
					},
					"GetName" => {
						let index: i32 = message.body().deserialize().unwrap();
						let name = usize::try_from(index)
							.ok()
							.and_then(|index| case.2.get(index))
							.copied()
							.unwrap_or("");
						server.reply(&header, &name).await.unwrap();
					},
					"GetActions" => {
						let actions: Vec<_> = case.1.iter().map(|name| (*name, "", "")).collect();
						server.reply(&header, &actions).await.unwrap();
					},
					"GetRole" => server.reply(&header, &(case.4 as u32)).await.unwrap(),
					_ => server
						.reply_error(&header, "org.freedesktop.DBus.Error.UnknownInterface", &"")
						.await
						.unwrap(),
				}
			}
		}

		let rt = Builder::new_current_thread().enable_all().build().unwrap();
		let (results, huge) = rt.block_on(async {
			let (client, server) = tokio::net::UnixStream::pair().unwrap();
			let server = ConnectionBuilder::unix_stream(server)
				.server(atspi::zbus::Guid::generate())
				.unwrap()
				.p2p()
				.build();
			let client = ConnectionBuilder::unix_stream(client).p2p().build();
			let (server, client) = tokio::try_join!(server, client).unwrap();
			let reads = async {
				let mut results = Vec::new();
				for (path, .., requested, _) in CASES {
					let object = ObjectRefOwned::from_static_str_unchecked(PEER, path);
					let accessible = object.as_accessible_proxy(&client).await.unwrap();
					let action = AtSpiAx::action(&client, &object).await.unwrap();
					results.push(resolve_action(&action, &accessible, requested).await.ok());
				}
				let object = ObjectRefOwned::from_static_str_unchecked(PEER, "/huge");
				let action = AtSpiAx::action(&client, &object).await.unwrap();
				(results, action_names(&action).await.unwrap().len())
			};
			tokio::select! {
				reads = reads => reads,
				() = app(server) => unreachable!("the app stopped answering"),
			}
		});
		let expected: Vec<_> = CASES.iter().map(|case| case.6).collect();
		assert_eq!(results, expected);
		assert_eq!(huge, MAX_ACTIONS as usize);
	}

	mod unanswered {
		use atspi::zbus::{
			Guid, connection::Builder as ConnectionBuilder, interface, zvariant::OwnedObjectPath,
		};

		use super::*;
		use crate::desktop::control;

		const PEER: &str = ":1.7";
		/// Long enough for every call this process answers itself.
		const HUNG_CALL_TIMEOUT: Duration = Duration::from_secs(1);

		fn path(p: &str) -> OwnedObjectPath {
			OwnedObjectPath::try_from(p).unwrap()
		}

		/// The backend over a peer-to-peer connection to what `serve` serves.
		fn backend(
			reply_timeout: Duration,
			serve: impl FnOnce(ConnectionBuilder<'static>) -> ConnectionBuilder<'static>,
		) -> (AtSpiAx, Connection) {
			let rt = Builder::new_current_thread().enable_all().build().unwrap();
			let (server, connection) = rt.block_on(async {
				let (client, server) = tokio::net::UnixStream::pair().unwrap();
				let server = ConnectionBuilder::unix_stream(server)
					.server(Guid::generate())
					.unwrap()
					.p2p();
				let client = ConnectionBuilder::unix_stream(client).p2p().build();
				tokio::try_join!(serve(server).build(), client).unwrap()
			});
			(AtSpiAx { rt, connection, reply_timeout }, server)
		}

		/// An element of an application that answers no method call, as a GTK 3
		/// app does while a dialog an accessibility action opened is up. (It
		/// has no properties: the server answers those inline, so a property
		/// that never answers would silence every other element too.)
		struct Silent {
			/// Cancelled when the first call arrives, as the host cancels a run
			/// that times out.
			cancel: Option<control::CancellationSource>,
		}

		#[interface(name = "org.a11y.atspi.Accessible")]
		impl Silent {
			async fn get_role_name(&self) -> String {
				if let Some(cancel) = &self.cancel {
					cancel.cancel();
				}
				std::future::pending().await
			}

			async fn get_state(&self) -> Vec<u32> {
				std::future::pending().await
			}

			async fn get_children(&self) -> Vec<(String, OwnedObjectPath)> {
				std::future::pending().await
			}
		}

		struct Element {
			name:     &'static str,
			role:     Role,
			focused:  bool,
			children: Vec<(String, OwnedObjectPath)>,
		}

		#[interface(name = "org.a11y.atspi.Accessible")]
		impl Element {
			#[zbus(property)]
			fn name(&self) -> String {
				self.name.to_owned()
			}

			fn get_role(&self) -> u32 {
				self.role as u32
			}

			fn get_state(&self) -> Vec<u32> {
				let state = if self.focused {
					State::Focused as u64
				} else {
					0
				};
				vec![state as u32, (state >> 32) as u32]
			}

			fn get_children(&self) -> Vec<(String, OwnedObjectPath)> {
				self.children.clone()
			}
		}

		/// A frame at `(x, y)` on screen, and at the origin in window
		/// coordinates.
		struct Extents {
			x: i32,
			y: i32,
		}

		#[interface(name = "org.a11y.atspi.Component")]
		impl Extents {
			fn get_extents(&self, coord_type: u32) -> (i32, i32, i32, i32) {
				if coord_type == CoordType::Window as u32 {
					(0, 0, 300, 200)
				} else {
					(self.x, self.y, 300, 200)
				}
			}
		}

		fn silent_element(
			reply_timeout: Duration,
			cancel: Option<control::CancellationSource>,
		) -> (AtSpiAx, Connection) {
			backend(reply_timeout, |server| server.serve_at("/silent", Silent { cancel }).unwrap())
		}

		#[test]
		fn a_request_the_application_never_answers_times_out() {
			let (mut ax, _server) = silent_element(HUNG_CALL_TIMEOUT, None);
			let element = AxHandle::AtSpi(ObjectRefOwned::from_static_str_unchecked(PEER, "/silent"));
			assert_eq!(ax.props(&element).unwrap_err().code, ErrorCode::Timeout);
		}

		#[test]
		fn a_cancel_frees_a_request_the_application_never_answers() {
			let source = control::CancellationSource::default();
			let (mut ax, _server) = silent_element(REPLY_TIMEOUT, Some(source.clone()));
			let element = AxHandle::AtSpi(ObjectRefOwned::from_static_str_unchecked(PEER, "/silent"));
			let error =
				control::with_token_for_test(&source.token(), || ax.props(&element)).unwrap_err();
			assert_eq!(error.code, ErrorCode::Cancelled);
		}

		/// A desktop of two applications: one that answers nothing on bus
		/// `:1.8`, listed first, and an editor whose document frame, at
		/// `(10, 20)` on screen, has the focus when `focused`. (A peer-to-peer
		/// connection ignores the destination, so this process serves both.)
		fn desktop(focused: bool) -> (AtSpiAx, Connection) {
			backend(HUNG_CALL_TIMEOUT, |server| {
				server
					.serve_at("/org/a11y/atspi/accessible/root", Element {
						name:     "main",
						role:     Role::DesktopFrame,
						focused:  false,
						children: vec![
							(":1.8".to_owned(), path("/silent")),
							(PEER.to_owned(), path("/editor")),
						],
					})
					.unwrap()
					.serve_at("/silent", Silent { cancel: None })
					.unwrap()
					.serve_at("/editor", Element {
						name:     "Editor",
						role:     Role::Application,
						focused:  false,
						children: vec![(PEER.to_owned(), path("/editor/frame"))],
					})
					.unwrap()
					.serve_at("/editor/frame", Element {
						name: "Document",
						role: Role::Frame,
						focused,
						children: Vec::new(),
					})
					.unwrap()
					.serve_at("/editor/frame", Extents { x: 10, y: 20 })
					.unwrap()
			})
		}

		#[test]
		fn windows_and_focus_leave_out_an_application_that_never_answers() {
			let (mut ax, _server) = desktop(true);
			let listed = ax.windows().unwrap();
			assert_eq!(
				listed
					.windows
					.iter()
					.map(|listed| (listed.window.app.as_str(), listed.window.title.as_str()))
					.collect::<Vec<_>>(),
				[("Editor", "Document")]
			);
			assert_eq!(listed.unanswered, [":1.8"]);
			let Some(AxHandle::AtSpi(focused)) = ax.focused_element().unwrap() else {
				panic!("the answering application's focus must be found");
			};
			assert_eq!(focused.path_as_str(), "/editor/frame");
		}

		#[test]
		fn focus_found_nowhere_else_may_be_in_an_application_that_never_answers() {
			let (mut ax, _server) = desktop(false);
			assert_eq!(ax.focused_element().err().map(|error| error.code), Some(ErrorCode::Timeout));
		}

		#[test]
		fn a_point_an_application_that_never_answers_may_own_is_not_resolved() {
			let (mut ax, _server) = desktop(true);
			assert_eq!(
				ax.element_at(50.0, 50.0).err().map(|error| error.code),
				Some(ErrorCode::Timeout)
			);
		}

		/// A menu bar that names its parent frame and then answers no method
		/// call.
		struct SilentMenuBar {
			parent: (String, OwnedObjectPath),
		}

		#[interface(name = "org.a11y.atspi.Accessible")]
		impl SilentMenuBar {
			#[zbus(property)]
			fn parent(&self) -> (String, OwnedObjectPath) {
				self.parent.clone()
			}

			async fn get_role(&self) -> u32 {
				std::future::pending().await
			}
		}

		#[test]
		fn a_menu_read_fails_when_the_application_stops_answering_part_way() {
			let (mut ax, _server) = backend(HUNG_CALL_TIMEOUT, |server| {
				server
					.serve_at("/org/a11y/atspi/accessible/root", Element {
						name:     "main",
						role:     Role::DesktopFrame,
						focused:  false,
						children: vec![(PEER.to_owned(), path("/editor"))],
					})
					.unwrap()
					.serve_at("/editor", Element {
						name:     "Editor",
						role:     Role::Application,
						focused:  false,
						children: vec![(PEER.to_owned(), path("/editor/frame"))],
					})
					.unwrap()
					.serve_at("/editor/frame", Element {
						name:     "Document",
						role:     Role::Frame,
						focused:  true,
						children: vec![(PEER.to_owned(), path("/editor/frame/menubar"))],
					})
					.unwrap()
					.serve_at("/editor/frame/menubar", SilentMenuBar {
						parent: (PEER.to_owned(), path("/editor/frame")),
					})
					.unwrap()
			});
			let window = DesktopWindow {
				id:      format!("atspi:{PEER}:/editor/frame"),
				title:   "Document".into(),
				app:     "Editor".into(),
				pid:     None,
				x:       0,
				y:       0,
				width:   300,
				height:  200,
				focused: true,
			};
			assert_eq!(
				ax.menu_items(&window, &[]).err().map(|error| error.code),
				Some(ErrorCode::Timeout)
			);
		}
	}
}
