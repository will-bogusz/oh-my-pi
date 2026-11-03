use std::{collections::HashMap, time::Duration};

use atspi::{
	CoordType, Layer, ObjectRefOwned, Role, State, StateSet,
	proxy::{
		accessible::{AccessibleProxy, ObjectRefExt},
		bus::BusProxy,
	},
	zbus::{self, Connection, proxy::CacheProperties},
};
use tokio::runtime::{Builder, Runtime};

use crate::desktop::{
	ax::{AxBounds, AxHandle, AxProps, WalkBounds, normalize_role_atspi},
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
	/// The display server's own list of windows, where it knows where each one
	/// is (X11).
	native:        Option<Box<dyn NativeWindows>>,
	frames:        FrameCache,
}

/// A native top-level window's geometry as the display server reports it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NativeGeometry {
	pub x:      i32,
	pub y:      i32,
	pub width:  u32,
	pub height: u32,
	/// The shadow a client-side-decorated window draws inside its own surface
	/// (`_GTK_FRAME_EXTENTS`): left, right, top, bottom.
	pub shadow: [u32; 4],
}

/// Where the display server put each top-level window.
///
/// GTK4 answers `CoordType::Screen` with `0,0` for every element, on X11 as
/// on Wayland, while its `CoordType::Window` extents are right. Where the
/// display server knows the window's position, an element's screen position
/// is its window position plus that.
pub(crate) trait NativeWindows: Send + Sync {
	fn windows(&self) -> CoreResult<Vec<DesktopWindow>>;
	/// The current geometry of native window `id`; `None` once it is gone or
	/// off screen (unmapped, minimized).
	fn geometry(&self, id: &str) -> Option<NativeGeometry>;
}

/// What a tree walk learns about frames, kept from one `window_root` to the
/// next so the walk looks each up once.
#[derive(Default)]
struct FrameCache {
	/// Each element's top-level frame; `None` inside a popup, whose window
	/// extents GTK4 before 4.18 measures from the widget it hangs off rather
	/// than from where it is drawn.
	frame_of:  HashMap<ObjectRefOwned, Option<ObjectRefOwned>>,
	/// Whether each frame's toolkit answers screen coordinates with window
	/// ones (GTK4).
	unplaced:  HashMap<ObjectRefOwned, bool>,
	/// Each frame's native window id; `None` when no single one matches.
	native_of: HashMap<ObjectRefOwned, Option<String>>,
}

/// Where a frame whose screen position its toolkit cannot report sits on
/// screen: the origin of its window coordinates and its size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Placement {
	x:      i32,
	y:      i32,
	width:  i32,
	height: i32,
}

impl Placement {
	fn contains(self, x: i32, y: i32) -> bool {
		x >= self.x
			&& y >= self.y
			&& i64::from(x) < i64::from(self.x) + i64::from(self.width)
			&& i64::from(y) < i64::from(self.y) + i64::from(self.height)
	}
}

/// Where a frame of `frame_width` x `frame_height` in native window `native`
/// starts on screen: at the window's origin when the frame fills it, inside
/// the client-side shadow when the frame fills what the shadow leaves. `None`
/// when the size fits neither, so the frame's place in the window is unknown.
fn placement(frame_width: i32, frame_height: i32, native: &NativeGeometry) -> Option<Placement> {
	let [left, right, top, bottom] = native.shadow.map(i64::from);
	let (width, height) = (i64::from(native.width), i64::from(native.height));
	let (frame_width_64, frame_height_64) = (i64::from(frame_width), i64::from(frame_height));
	let (x, y) = if (frame_width_64, frame_height_64) == (width, height) {
		(0, 0)
	} else if (frame_width_64, frame_height_64) == (width - left - right, height - top - bottom) {
		(left, top)
	} else {
		return None;
	};
	Some(Placement {
		x:      i32::try_from(i64::from(native.x) + x).ok()?,
		y:      i32::try_from(i64::from(native.y) + y).ok()?,
		width:  frame_width,
		height: frame_height,
	})
}

/// Whether the user can operate an element. GTK4 marks an enabled control
/// only `Sensitive`, which AT-SPI allows for a control the user can operate;
/// toolkits drop both states from a greyed-out one.
fn state_enabled(states: StateSet) -> bool {
	states.contains(State::Enabled) || states.contains(State::Sensitive)
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
		Ok(Self {
			rt,
			connection,
			reply_timeout: REPLY_TIMEOUT,
			native: None,
			frames: FrameCache::default(),
		})
	}

	/// Places elements of toolkits that cannot report screen positions by
	/// where `native` says their window is.
	pub(crate) fn with_native_windows(mut self, native: Box<dyn NativeWindows>) -> Self {
		self.native = Some(native);
		self
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

	/// An element's properties, with its bounds when `bounds` asks for them,
	/// and its children when `children` asks: [`Self::request`] with the
	/// frame cache borrowed mutably.
	fn read_node(
		&mut self,
		h: &AxHandle,
		bounds: WalkBounds,
		children: bool,
	) -> CoreResult<(AxProps, Vec<ObjectRefOwned>)> {
		let Self { rt, connection, reply_timeout, native, frames } = self;
		let read = Self::read_element(
			connection,
			frames,
			native.as_deref(),
			Self::object(h),
			bounds,
			children,
		);
		rt.block_on(cancellable(answered("the application", *reply_timeout, read)))??
	}

	/// [`Self::read_node`] on `bus`. Every request waits a round trip on the
	/// app, so they go out together in two rounds: the element's own fields and
	/// the interfaces it implements, then only the interfaces it has.
	async fn read_element(
		bus: &zbus::Connection,
		frames: &mut FrameCache,
		native: Option<&dyn NativeWindows>,
		object: &ObjectRefOwned,
		bounds: WalkBounds,
		children: bool,
	) -> CoreResult<(AxProps, Vec<ObjectRefOwned>)> {
		let proxy = object
			.as_accessible_proxy(bus)
			.await
			.map_err(|err| DesktopError::ax_failed(format!("AT-SPI accessible: {err}")))?;
		let (title, description, role_name, state, interfaces, child_refs, child_count) = futures::join!(
			proxy.name(),
			proxy.description(),
			proxy.get_role_name(),
			proxy.get_state(),
			proxy.get_interfaces(),
			async {
				if children {
					Some(proxy.get_children().await)
				} else {
					None
				}
			},
			async {
				if children {
					None
				} else {
					proxy.child_count().await.ok()
				}
			},
		);
		let native_role = match role_name {
			Ok(role) => role,
			Err(_) => proxy
				.get_localized_role_name()
				.await
				.unwrap_or_else(|_| "unknown".to_string()),
		};
		// An element whose interfaces cannot be read is asked on each.
		let has = |interface| {
			interfaces
				.as_ref()
				.ok()
				.is_none_or(|interfaces| interfaces.contains(interface))
		};
		let (value, bounds, actions) = futures::join!(
			async {
				if has(atspi::Interface::Text) {
					text_value(bus, object).await
				} else {
					None
				}
			},
			async {
				if bounds == WalkBounds::Read && has(atspi::Interface::Component) {
					frames.screen_bounds(bus, native, object).await
				} else {
					None
				}
			},
			async {
				if !has(atspi::Interface::Action) {
					return Vec::new();
				}
				match Self::action(bus, object).await {
					Ok(action) => action_names(&action).await.unwrap_or_default(),
					Err(_) => Vec::new(),
				}
			},
		);
		let child_refs = match child_refs {
			Some(refs) => {
				refs.map_err(|err| DesktopError::ax_failed(format!("AT-SPI children: {err}")))?
			},
			None => Vec::new(),
		};
		let child_count = child_count.map_or(child_refs.len(), |count| count.max(0) as usize) as u32;
		let state = state.ok();
		let multiline = state
			.as_ref()
			.is_some_and(|states| states.contains(State::MultiLine));
		let props = AxProps {
			role: normalize_role_atspi(&native_role, multiline),
			native_role,
			title: title.ok().filter(|s| !s.is_empty()),
			value,
			description: description.ok().filter(|s| !s.is_empty()),
			enabled: state.is_some_and(state_enabled),
			focused: state
				.as_ref()
				.is_some_and(|states| states.contains(State::Focused)),
			bounds,
			actions,
			child_count,
			identity: None,
			partial: false,
		};
		Ok((
			props,
			child_refs
				.into_iter()
				.filter(|child| !child.is_null())
				.collect(),
		))
	}

	/// The deepest element under `root` at screen point (`x`, `y`). A placed
	/// frame is hit-tested in its window coordinates.
	async fn descend(
		connection: &zbus::Connection,
		root: ObjectRefOwned,
		placement: Option<Placement>,
		x: i32,
		y: i32,
	) -> CoreResult<Option<AxHandle>> {
		let (coords, x, y) = match placement {
			Some(placement) => {
				(CoordType::Window, x.saturating_sub(placement.x), y.saturating_sub(placement.y))
			},
			None => (CoordType::Screen, x, y),
		};
		let mut current = root;
		let mut ancestors = Vec::new();
		for _ in 0..64 {
			let has_component = {
				let accessible = current
					.as_accessible_proxy(connection)
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI hit-test element: {err}")))?;
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
			let child = Self::component(connection, &current)
				.await
				.map_err(DesktopError::ax_failed)?
				.get_accessible_at_point(x, y, coords)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI element at point: {err}")))?;
			if child.is_null() || child == current {
				return Ok(Some(AxHandle::AtSpi(current)));
			}
			// GTK4 returns the deepest element from the frame, then offsets the
			// point twice below it and can name a child the point is not in.
			if placement.is_some() {
				let inside = Self::component(connection, &child)
					.await
					.map_err(DesktopError::ax_failed)?
					.get_extents(CoordType::Window)
					.await
					.is_ok_and(|(left, top, width, height)| {
						Placement { x: left, y: top, width, height }.contains(x, y)
					});
				if !inside {
					return Ok(Some(AxHandle::AtSpi(current)));
				}
			}
			if ancestors.contains(&child) {
				return Err(DesktopError::ax_failed("AT-SPI hit-test hierarchy contains a cycle"));
			}
			ancestors.push(current);
			current = child;
		}
		Err(DesktopError::ax_failed("AT-SPI hit-test hierarchy exceeds the depth limit"))
	}
}

impl FrameCache {
	/// `object`'s bounds in screen coordinates. A toolkit that cannot place its
	/// windows (GTK4) reports every element at screen `0,0`; such an element is
	/// placed by its window extents and where `native` says its frame is, and
	/// is left as reported where `native` cannot say.
	async fn screen_bounds(
		&mut self,
		connection: &zbus::Connection,
		native: Option<&dyn NativeWindows>,
		object: &ObjectRefOwned,
	) -> Option<AxBounds> {
		let component = AtSpiAx::component(connection, object).await.ok()?;
		let (mut x, mut y, width, height) = component.get_extents(CoordType::Screen).await.ok()?;
		if width < 0 || height < 0 {
			return None;
		}
		if (x, y) == (0, 0)
			&& let Some(native) = native
			&& let Some(frame) = self.frame(connection, object).await
			&& let Some(placement) = self.placement(connection, native, &frame).await
			&& let Ok((window_x, window_y, ..)) = component.get_extents(CoordType::Window).await
		{
			x = placement.x.saturating_add(window_x);
			y = placement.y.saturating_add(window_y);
		}
		Some(AxBounds {
			x:      f64::from(x),
			y:      f64::from(y),
			width:  f64::from(width),
			height: f64::from(height),
		})
	}

	/// Whether `frame` holds screen point (`x`, `y`): `Some` with where it sits
	/// when its toolkit cannot place it, `Some(None)` when it reports screen
	/// positions itself. Such a frame `native` cannot place either (minimized,
	/// another workspace) holds no point.
	async fn claim(
		&mut self,
		connection: &zbus::Connection,
		native: Option<&dyn NativeWindows>,
		frame: &ObjectRefOwned,
		x: i32,
		y: i32,
	) -> CoreResult<Option<Option<Placement>>> {
		if let Some(native) = native
			&& self.unplaced(connection, frame).await
		{
			let placement = self.placement(connection, native, frame).await;
			return Ok(placement
				.filter(|placement| placement.contains(x, y))
				.map(Some));
		}
		let contains = AtSpiAx::component(connection, frame)
			.await
			.map_err(DesktopError::ax_failed)?
			.contains(x, y, CoordType::Screen)
			.await
			.map_err(|err| DesktopError::ax_failed(format!("AT-SPI frame hit test: {err}")))?;
		Ok(contains.then_some(None))
	}

	/// Where `frame` sits on screen, from its native window, when its toolkit
	/// cannot say; `None` when it can.
	async fn placement(
		&mut self,
		connection: &zbus::Connection,
		native: &dyn NativeWindows,
		frame: &ObjectRefOwned,
	) -> Option<Placement> {
		if !self.unplaced(connection, frame).await {
			return None;
		}
		let (.., width, height) = AtSpiAx::component(connection, frame)
			.await
			.ok()?
			.get_extents(CoordType::Window)
			.await
			.ok()?;
		let geometry = self.native_geometry(connection, native, frame).await?;
		placement(width, height, &geometry)
	}

	/// Whether `frame`'s toolkit answers screen coordinates with window ones.
	/// GTK4 puts its frames at screen `0,0` and answers `Contains` true even
	/// for a point above and left of them.
	async fn unplaced(&mut self, connection: &zbus::Connection, frame: &ObjectRefOwned) -> bool {
		if let Some(&unplaced) = self.unplaced.get(frame) {
			return unplaced;
		}
		let Ok(component) = AtSpiAx::component(connection, frame).await else {
			return false;
		};
		let unplaced = component
			.get_extents(CoordType::Screen)
			.await
			.is_ok_and(|(x, y, ..)| (x, y) == (0, 0))
			&& component
				.contains(-1, -1, CoordType::Screen)
				.await
				.unwrap_or(false);
		self.unplaced.insert(frame.clone(), unplaced);
		unplaced
	}

	/// The top-level frame holding `object`: its ancestor that is a child of the
	/// application, whatever its role. `None` inside a popup.
	async fn frame(
		&mut self,
		connection: &zbus::Connection,
		object: &ObjectRefOwned,
	) -> Option<ObjectRefOwned> {
		let mut chain: Vec<ObjectRefOwned> = Vec::new();
		// Index in `chain` of the outermost popup met so far.
		let mut popup = None;
		let mut current = object.clone();
		let frame = loop {
			if let Some(frame) = self.frame_of.get(&current) {
				break frame.clone();
			}
			if chain.len() == 64 {
				return None;
			}
			let proxy = current.as_accessible_proxy(connection).await.ok()?;
			if proxy.get_role().await.ok()? == Role::Application {
				break chain.last().cloned();
			}
			if let Ok(component) = AtSpiAx::component(connection, &current).await
				&& component
					.get_layer()
					.await
					.is_ok_and(|layer| layer == Layer::Popup)
			{
				popup = Some(chain.len());
			}
			let parent = proxy.parent().await.ok()?;
			if parent.is_null() || parent == current {
				return None;
			}
			drop(proxy);
			chain.push(std::mem::replace(&mut current, parent));
		};
		let outside_popup = |index: usize| popup.is_none_or(|popup| index > popup);
		let own = frame
			.clone()
			.filter(|_| chain.is_empty() || outside_popup(0));
		for (index, object) in chain.into_iter().enumerate() {
			self
				.frame_of
				.insert(object, frame.clone().filter(|_| outside_popup(index)));
		}
		own
	}

	/// The current geometry of the native window showing `frame`, matched once
	/// by process and title.
	async fn native_geometry(
		&mut self,
		connection: &zbus::Connection,
		native: &dyn NativeWindows,
		frame: &ObjectRefOwned,
	) -> Option<NativeGeometry> {
		match self.native_of.get(frame) {
			Some(None) => return None,
			Some(Some(id)) => {
				if let Some(geometry) = native.geometry(id) {
					return Some(geometry);
				}
			},
			None => {},
		}
		let id = native_window(connection, native, frame).await;
		let geometry = id.as_deref().and_then(|id| native.geometry(id));
		self
			.native_of
			.insert(frame.clone(), id.filter(|_| geometry.is_some()));
		geometry
	}
}

/// The native window showing `frame`, the one window of its process with its
/// title.
async fn native_window(
	connection: &zbus::Connection,
	native: &dyn NativeWindows,
	frame: &ObjectRefOwned,
) -> Option<String> {
	let title = frame
		.as_accessible_proxy(connection)
		.await
		.ok()?
		.name()
		.await
		.ok()?;
	let pid = zbus::fdo::DBusProxy::new(connection)
		.await
		.ok()?
		.get_connection_unix_process_id(frame.name()?.clone().into())
		.await
		.ok()?;
	native_window_for_frame(&native.windows().ok()?, pid, &title).ok()
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

/// The text of an element with the `Text` interface, up to 16,384 characters,
/// read without zbus's property cache, whose `GetAll` Qt refuses.
async fn text_value(connection: &zbus::Connection, object: &ObjectRefOwned) -> Option<String> {
	let text = atspi::proxy::text::TextProxy::builder(connection)
		.destination(object.name()?.clone())
		.ok()?
		.path(object.path().clone())
		.ok()?
		.cache_properties(zbus::proxy::CacheProperties::No)
		.build()
		.await
		.ok()?;
	let count = text.character_count().await.ok()?.min(16_384);
	text.get_text(0, count).await.ok().filter(|s| !s.is_empty())
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
		self.frames = FrameCache::default();
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
		self
			.read_node(h, WalkBounds::Read, false)
			.map(|(props, _)| props)
	}

	fn walk_node(
		&mut self,
		h: &AxHandle,
		bounds: WalkBounds,
	) -> CoreResult<(AxProps, Vec<AxHandle>)> {
		let (props, children) = self.read_node(h, bounds, true)?;
		Ok((props, children.into_iter().map(AxHandle::AtSpi).collect()))
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
		let Self { rt, connection, reply_timeout, native, frames: cache } = self;
		let reply_timeout = *reply_timeout;
		rt.block_on(cancellable(async {
			let mut root: Option<(ObjectRefOwned, Option<Placement>)> = None;
			for app in Self::apps(connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				// An application that does not answer may own the point, so no
				// other application's frame is known to be on top.
				let claimed = answered("an application", reply_timeout, async {
					let mut claimed = Vec::new();
					for frame in Self::frames(connection, &app)
						.await
						.map_err(DesktopError::ax_failed)?
					{
						if let Some(placement) = cache
							.claim(connection, native.as_deref(), &frame, x, y)
							.await?
						{
							claimed.push((frame, placement));
						}
					}
					CoreResult::Ok(claimed)
				})
				.await??;
				for (frame, placement) in claimed {
					// AT-SPI enumeration is not stacking order. Never choose an
					// arbitrary frame when two top-levels contain the point.
					if let Some((previous, _)) = &root {
						if previous != &frame {
							return Err(DesktopError::ax_failed(
								"multiple AT-SPI windows contain this point; topmost ownership is \
								 ambiguous",
							));
						}
					} else {
						root = Some((frame, placement));
					}
				}
			}
			let Some((root, placement)) = root else {
				return Ok(None);
			};
			answered(
				"the application",
				reply_timeout,
				Self::descend(connection, root, placement, x, y),
			)
			.await?
		}))?
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
	fn sensitive_controls_are_enabled() {
		// GTK4 marks an enabled control only `Sensitive`.
		assert!(state_enabled(StateSet::new(State::Sensitive | State::Focusable)));
		assert!(state_enabled(StateSet::new(State::Enabled | State::Sensitive)));
		// GTK4's Back button with no history, GTK3's Save on a read-only file.
		assert!(!state_enabled(StateSet::new(State::Focusable | State::Showing)));
	}

	#[test]
	fn placement_fits_the_frame_to_its_native_window() {
		let window =
			NativeGeometry { x: 300, y: 200, width: 890, height: 550, shadow: [0; 4] };
		assert_eq!(
			placement(890, 550, &window),
			Some(Placement { x: 300, y: 200, width: 890, height: 550 })
		);
		// GTK4's window coordinates start inside the shadow it draws.
		let shadowed = NativeGeometry { width: 942, height: 604, shadow: [26, 26, 23, 31], ..window };
		assert_eq!(
			placement(890, 550, &shadowed),
			Some(Placement { x: 326, y: 223, width: 890, height: 550 })
		);
		assert_eq!(placement(400, 300, &shadowed), None);
		assert!(Placement { x: 300, y: 200, width: 890, height: 550 }.contains(300, 749));
		assert!(!Placement { x: 300, y: 200, width: 890, height: 550 }.contains(1190, 400));
	}

	const PEER: &str = ":1.7";

	type Rect = (i32, i32, i32, i32);

	const fn inside((left, top, width, height): Rect, x: i32, y: i32) -> bool {
		x >= left && y >= top && x < left + width && y < top + height
	}

	fn object_path(path: &str) -> atspi::zbus::zvariant::OwnedObjectPath {
		atspi::zbus::zvariant::OwnedObjectPath::try_from(path).unwrap()
	}

	/// A fake `org.a11y.atspi.Accessible` with its role, name and parent.
	struct Node {
		role:   Role,
		name:   &'static str,
		parent: &'static str,
	}

	#[atspi::zbus::interface(name = "org.a11y.atspi.Accessible")]
	impl Node {
		fn get_role(&self) -> u32 {
			self.role as u32
		}

		#[allow(clippy::unused_self, reason = "every fake node has a Component")]
		fn get_interfaces(&self) -> Vec<&'static str> {
			vec!["org.a11y.atspi.Accessible", "org.a11y.atspi.Component"]
		}

		#[zbus(property)]
		fn name(&self) -> String {
			self.name.to_owned()
		}

		#[zbus(property)]
		fn parent(&self) -> (String, atspi::zbus::zvariant::OwnedObjectPath) {
			(PEER.to_owned(), object_path(self.parent))
		}
	}

	/// A fake `org.a11y.atspi.Component`. `lies` answers `Contains` true for
	/// any point, as GTK4 does; `at_point` lists, per coordinate type, where
	/// `GetAccessibleAtPoint` names which child.
	struct Extents {
		screen:   Rect,
		window:   Rect,
		lies:     bool,
		popup:    bool,
		at_point: Vec<(CoordType, Rect, &'static str)>,
	}

	impl Extents {
		/// What GTK4 reports for an element at `window`: screen `0,0`.
		fn gtk4(window: Rect) -> Self {
			let (.., width, height) = window;
			Self { screen: (0, 0, width, height), window, lies: true, popup: false, at_point: vec![] }
		}

		/// What a toolkit that reports screen positions does.
		fn placed(screen: Rect, window: Rect) -> Self {
			Self { screen, window, lies: false, popup: false, at_point: vec![] }
		}

		fn at(mut self, coords: CoordType, rect: Rect, child: &'static str) -> Self {
			self.at_point.push((coords, rect, child));
			self
		}
	}

	#[atspi::zbus::interface(name = "org.a11y.atspi.Component")]
	impl Extents {
		fn get_extents(&self, coords: u32) -> Rect {
			if coords == CoordType::Window as u32 {
				self.window
			} else {
				self.screen
			}
		}

		fn contains(&self, x: i32, y: i32, coords: u32) -> bool {
			self.lies || inside(self.get_extents(coords), x, y)
		}

		fn get_accessible_at_point(
			&self,
			x: i32,
			y: i32,
			coords: u32,
		) -> (String, atspi::zbus::zvariant::OwnedObjectPath) {
			let child = self
				.at_point
				.iter()
				.find(|(at, rect, _)| *at as u32 == coords && inside(*rect, x, y))
				.map_or("/org/a11y/atspi/null", |(.., child)| child);
			(PEER.to_owned(), object_path(child))
		}

		fn get_layer(&self) -> u32 {
			if self.popup {
				Layer::Popup as u32
			} else {
				Layer::Widget as u32
			}
		}
	}

	/// The bus daemon's process lookup, for the frames' process.
	struct Bus {
		pid: u32,
	}

	#[atspi::zbus::interface(name = "org.freedesktop.DBus")]
	impl Bus {
		#[zbus(name = "GetConnectionUnixProcessID")]
		fn pid(&self, name: String) -> u32 {
			assert_eq!(name, PEER);
			self.pid
		}
	}

	/// The display server's windows, all 890x550 and of process 7.
	struct Native(std::sync::Mutex<Vec<DesktopWindow>>);

	impl Native {
		fn new(windows: &[(&str, &str, i32, i32)]) -> Self {
			let windows = windows
				.iter()
				.map(|&(id, title, x, y)| window(id, title, x, y));
			Self(std::sync::Mutex::new(windows.collect()))
		}
	}

	fn window(id: &str, title: &str, x: i32, y: i32) -> DesktopWindow {
		DesktopWindow {
			id: id.into(),
			pid: Some(7),
			title: title.into(),
			app: "app".into(),
			x,
			y,
			width: 890,
			height: 550,
			focused: false,
		}
	}

	impl NativeWindows for Native {
		fn windows(&self) -> CoreResult<Vec<DesktopWindow>> {
			Ok(self.0.lock().unwrap().clone())
		}

		fn geometry(&self, id: &str) -> Option<NativeGeometry> {
			let windows = self.0.lock().unwrap();
			let window = windows.iter().find(|window| window.id == id)?;
			Some(NativeGeometry {
				x:      window.x,
				y:      window.y,
				width:  window.width,
				height: window.height,
				shadow: [0; 4],
			})
		}
	}

	/// Serves `tree` as process 7 and returns the server and a client
	/// connection to it.
	async fn serve(
		tree: Vec<(&'static str, Node, Option<Extents>)>,
	) -> (atspi::zbus::Connection, atspi::zbus::Connection) {
		use atspi::zbus::connection::Builder as ConnectionBuilder;

		let (client, server) = tokio::net::UnixStream::pair().unwrap();
		let mut server = ConnectionBuilder::unix_stream(server)
			.server(atspi::zbus::Guid::generate())
			.unwrap()
			.p2p()
			.serve_at("/org/freedesktop/DBus", Bus { pid: 7 })
			.unwrap();
		for (path, node, extents) in tree {
			server = server.serve_at(path, node).unwrap();
			if let Some(extents) = extents {
				server = server.serve_at(path, extents).unwrap();
			}
		}
		let client = ConnectionBuilder::unix_stream(client).p2p().build();
		tokio::try_join!(server.build(), client).unwrap()
	}

	fn node(role: Role, name: &'static str, parent: &'static str) -> Node {
		Node { role, name, parent }
	}

	fn object(path: &'static str) -> ObjectRefOwned {
		ObjectRefOwned::from_static_str_unchecked(PEER, path)
	}

	async fn read_bounds(
		cache: &mut FrameCache,
		client: &atspi::zbus::Connection,
		native: Option<&dyn NativeWindows>,
		path: &'static str,
	) -> Option<(f64, f64, f64, f64)> {
		let bounds = cache.screen_bounds(client, native, &object(path)).await?;
		Some((bounds.x, bounds.y, bounds.width, bounds.height))
	}

	#[test]
	fn elements_reported_at_the_screen_origin_are_placed_by_their_window() {
		let rt = Builder::new_current_thread().enable_all().build().unwrap();
		let bounds = rt.block_on(async {
			// What Files (GTK 4.14) reports, with an open popover, and a control
			// of a toolkit that reports real screen positions.
			let (server, client) = serve(vec![
				("/app", node(Role::Application, "org.gnome.Nautilus", "/null"), None),
				("/frame", node(Role::Frame, "Desktop", "/app"), Some(Extents::gtk4((0, 0, 890, 550)))),
				("/list", node(Role::List, "", "/frame"), None),
				(
					"/downloads",
					node(Role::ListItem, "Downloads", "/list"),
					Some(Extents::gtk4((6, 242, 168, 36))),
				),
				(
					"/placed",
					node(Role::Button, "Open", "/frame"),
					Some(Extents::placed((280, 75, 67, 46), (15, 3, 67, 46))),
				),
				(
					"/popover",
					node(Role::Menu, "", "/frame"),
					Some(Extents { popup: true, ..Extents::gtk4((614, 6, 250, 322)) }),
				),
				(
					"/item",
					node(Role::MenuItem, "", "/popover"),
					Some(Extents::gtk4((662, 52, 190, 32))),
				),
			])
			.await;
			let native = Native::new(&[("42", "Desktop", 300, 200)]);
			let mut cache = FrameCache::default();
			let mut bounds = Vec::new();
			for path in ["/downloads", "/frame", "/placed", "/item"] {
				bounds.push(read_bounds(&mut cache, &client, Some(&native), path).await);
			}
			// The window was replaced by one elsewhere.
			*native.0.lock().unwrap() = vec![window("43", "Desktop", 500, 100)];
			bounds.push(read_bounds(&mut cache, &client, Some(&native), "/downloads").await);
			// Without a display server that knows (Wayland), as reported.
			bounds.push(read_bounds(&mut cache, &client, None, "/downloads").await);
			drop(server);
			bounds
		});
		assert_eq!(bounds, [
			Some((306.0, 442.0, 168.0, 36.0)),
			Some((300.0, 200.0, 890.0, 550.0)),
			Some((280.0, 75.0, 67.0, 46.0)),
			// GTK 4.14 measures a popover from the widget it hangs off.
			Some((0.0, 0.0, 190.0, 32.0)),
			Some((506.0, 342.0, 168.0, 36.0)),
			Some((0.0, 0.0, 168.0, 36.0)),
		]);
	}

	#[test]
	fn gtk4_frames_are_hit_tested_where_their_window_is() {
		let rt = Builder::new_current_thread().enable_all().build().unwrap();
		let (claims, found) = rt.block_on(async {
			let (server, client) = serve(vec![
				("/app", node(Role::Application, "app", "/null"), None),
				(
					"/frame",
					node(Role::Frame, "Desktop", "/app"),
					Some(Extents::gtk4((0, 0, 890, 550)).at(
						CoordType::Window,
						(6, 242, 168, 36),
						"/downloads",
					)),
				),
				(
					"/downloads",
					node(Role::ListItem, "Downloads", "/frame"),
					// GTK4 offsets the point again below the frame and names a
					// child the point is not in.
					Some(Extents::gtk4((6, 242, 168, 36)).at(
						CoordType::Window,
						(0, 0, 890, 550),
						"/stray",
					)),
				),
				(
					"/stray",
					node(Role::Label, "", "/downloads"),
					Some(Extents::gtk4((700, 500, 10, 10))),
				),
				// A GTK4 window the display server does not show (minimized).
				("/hidden", node(Role::Frame, "Hidden", "/app"), Some(Extents::gtk4((0, 0, 890, 550)))),
				// A toolkit that reports screen positions, its window at 0,0.
				(
					"/editor",
					node(Role::Frame, "Editor", "/app"),
					Some(Extents::placed((0, 0, 400, 300), (0, 0, 400, 300)).at(
						CoordType::Screen,
						(10, 10, 50, 20),
						"/open",
					)),
				),
				(
					"/open",
					node(Role::Button, "Open", "/editor"),
					Some(Extents::placed((10, 10, 50, 20), (10, 10, 50, 20))),
				),
			])
			.await;
			let native = Native::new(&[("42", "Desktop", 300, 200)]);
			let native: Option<&dyn NativeWindows> = Some(&native);
			let mut cache = FrameCache::default();
			let mut claims = Vec::new();
			for (path, x, y, native) in [
				("/frame", 390, 460, native),
				("/frame", 1250, 100, native),
				("/hidden", 390, 460, native),
				("/editor", 20, 15, native),
				("/editor", 500, 500, native),
				// Without a display server that knows (Wayland), as on `main`.
				("/frame", 1250, 100, None),
			] {
				claims.push(
					cache
						.claim(&client, native, &object(path), x, y)
						.await
						.unwrap(),
				);
			}
			let mut found = Vec::new();
			for (path, placement, x, y) in
				[("/frame", claims[0].flatten(), 390, 460), ("/editor", None, 20, 15)]
			{
				let element = AtSpiAx::descend(&client, object(path), placement, x, y)
					.await
					.unwrap();
				found.push(element.map(|element| AtSpiAx::object(&element).path_as_str().to_owned()));
			}
			drop(server);
			(claims, found)
		});
		let placed = Placement { x: 300, y: 200, width: 890, height: 550 };
		assert_eq!(claims, [Some(Some(placed)), None, None, Some(None), None, Some(None)]);
		assert_eq!(found, [Some("/downloads".to_owned()), Some("/open".to_owned())]);
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

	#[test]
	fn an_element_is_read_in_two_rounds_and_only_on_its_interfaces() {
		use std::sync::Mutex;

		use atspi::zbus::{
			MessageStream,
			connection::Builder as ConnectionBuilder,
			message::Type,
			zvariant::{OwnedObjectPath, Value},
		};
		use futures::StreamExt;

		/// Answers like a Qt app: a Kate text view at `/text`, a button at
		/// `/button`, and at `/legacy` a text view that cannot list its
		/// interfaces, with `GetAll` refused as Qt refuses it. Each call must
		/// belong to the round under way, whose calls are held until all of
		/// them have come and then answered together; each answered round's
		/// `path member` list goes to `batches`.
		async fn qt(
			server: atspi::zbus::Connection,
			rounds: &[Vec<String>],
			batches: &Mutex<Vec<Vec<String>>>,
		) {
			let mut stream = MessageStream::from(&server);
			// After the last round, any call is outside it.
			for round in rounds.iter().chain(std::iter::once(&Vec::new())) {
				let mut batch = Vec::new();
				let mut names = Vec::new();
				while names.len() < round.len() || round.is_empty() {
					let Some(Ok(message)) = stream.next().await else {
						return;
					};
					if message.message_type() != Type::MethodCall {
						continue;
					}
					let header = message.header();
					let mut name = format!("{} {}", header.path().unwrap(), header.member().unwrap());
					if header.member().unwrap().as_str() == "Get" {
						let (_, property): (String, String) = message.body().deserialize().unwrap();
						name = format!("{name} {property}");
					}
					assert!(
						round.contains(&name) && !names.contains(&name),
						"{name} outside the round {round:?}"
					);
					names.push(name);
					batch.push(message);
				}
				for message in batch {
					let header = message.header();
					let path = header.path().unwrap().to_string();
					let text = path != "/button";
					match header.member().unwrap().as_str() {
						"Get" => {
							let (_, property): (String, String) = message.body().deserialize().unwrap();
							let value = match property.as_str() {
								"Name" => Value::from(if text { "notes.txt" } else { "New" }),
								"Description" => Value::from(""),
								"CharacterCount" => Value::from(5),
								"NActions" => Value::from(1),
								_ => Value::from(0),
							};
							server.reply(&header, &value).await.unwrap();
						},
						"GetAll" => server
							.reply_error(&header, "org.freedesktop.DBus.Error.UnknownInterface", &"")
							.await
							.unwrap(),
						"GetRoleName" => {
							server
								.reply(&header, &if text { "text" } else { "push button" })
								.await
								.unwrap();
						},
						"GetState" => server.reply(&header, &vec![0_u32, 0]).await.unwrap(),
						"GetInterfaces" if path != "/legacy" => {
							let interfaces: &[&str] = if text {
								&["org.a11y.atspi.Accessible", "org.a11y.atspi.Text"]
							} else {
								&["org.a11y.atspi.Accessible", "org.a11y.atspi.Action"]
							};
							server.reply(&header, &interfaces).await.unwrap();
						},
						"GetChildren" => {
							server
								.reply(&header, &Vec::<(String, OwnedObjectPath)>::new())
								.await
								.unwrap();
						},
						"GetText" => {
							let (start, end): (i32, i32) = message.body().deserialize().unwrap();
							let text: String = "hello"
								.chars()
								.skip(start as usize)
								.take((end - start) as usize)
								.collect();
							server.reply(&header, &text).await.unwrap();
						},
						"GetName" => server.reply(&header, &"press").await.unwrap(),
						_ => server
							.reply_error(&header, "org.freedesktop.DBus.Error.UnknownMethod", &"")
							.await
							.unwrap(),
					}
				}
				names.sort();
				batches.lock().unwrap().push(names);
			}
		}

		let round = |path: &str, members: &[&str]| {
			let mut names: Vec<_> = members
				.iter()
				.map(|member| format!("{path} {member}"))
				.collect();
			names.sort();
			names
		};
		let own = ["Get Name", "Get Description", "GetRoleName", "GetState", "GetInterfaces"];
		let first = |path: &str, children: &str| {
			let mut members = own.to_vec();
			members.push(children);
			round(path, &members)
		};
		let expected = [
			first("/text", "GetChildren"),
			round("/text", &["Get CharacterCount"]),
			round("/text", &["GetText"]),
			first("/button", "GetChildren"),
			round("/button", &["Get NActions"]),
			round("/button", &["GetName"]),
			// Without its interfaces, every one is asked.
			first("/legacy", "GetChildren"),
			round("/legacy", &["Get CharacterCount", "Get NActions", "GetExtents"]),
			round("/legacy", &["GetText", "GetName"]),
			// Without its children, only their count is.
			first("/button", "Get ChildCount"),
			round("/button", &["Get NActions"]),
			round("/button", &["GetName"]),
		];
		let batches = Mutex::new(Vec::new());

		let rt = Builder::new_current_thread().enable_all().build().unwrap();
		let reads = rt.block_on(async {
			let (client, server) = tokio::net::UnixStream::pair().unwrap();
			let server = ConnectionBuilder::unix_stream(server)
				.server(atspi::zbus::Guid::generate())
				.unwrap()
				.p2p()
				.build();
			let client = ConnectionBuilder::unix_stream(client).p2p().build();
			let (server, client) = tokio::try_join!(server, client).unwrap();
			let reads = async {
				let mut frames = FrameCache::default();
				let mut reads = Vec::new();
				for (path, children) in
					[("/text", true), ("/button", true), ("/legacy", true), ("/button", false)]
				{
					let (props, _) = AtSpiAx::read_element(
						&client,
						&mut frames,
						None,
						&object(path),
						WalkBounds::Read,
						children,
					)
					.await
					.unwrap();
					reads.push((props.role, props.title, props.value, props.actions));
				}
				reads
			};
			tokio::select! {
				reads = reads => reads,
				() = qt(server, &expected, &batches) => unreachable!("the app stopped answering"),
			}
		});
		let read = |role: &str, title: &str, value: Option<&str>, actions: &[&str]| {
			let actions: Vec<_> = actions.iter().map(|action| (*action).to_owned()).collect();
			(role.to_owned(), Some(title.to_owned()), value.map(str::to_owned), actions)
		};
		assert_eq!(reads, [
			read("textfield", "notes.txt", Some("hello"), &[]),
			read("button", "New", None, &["press"]),
			read("textfield", "notes.txt", Some("hello"), &["press"]),
			read("button", "New", None, &["press"]),
		]);
		assert_eq!(batches.into_inner().unwrap(), expected);
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
			let ax =
				AtSpiAx { rt, connection, reply_timeout, native: None, frames: FrameCache::default() };
			(ax, server)
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
