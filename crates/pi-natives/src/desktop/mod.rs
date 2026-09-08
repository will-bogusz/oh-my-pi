mod ax;
mod backend;
mod error;
mod frame;
mod keys;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod types;
#[cfg(any(target_os = "windows", test))]
mod win32;

use std::{
	collections::HashMap,
	panic::AssertUnwindSafe,
	sync::Arc,
	thread::{self, JoinHandle},
	time::Duration,
};

use ax::{AxRegistry, register_node};
use backend::{Backend, DeliveryMode, MouseButton, PointerEvent};
use error::{CoreResult, DesktopError};
use frame::{FrameGeometry, apply_capture_caps, encode_png};
use keys::{parse_keys, parse_modifiers};
use napi::{Result, bindgen_prelude::Uint8Array};
use napi_derive::napi;
use parking_lot::Mutex;
pub use types::*;

use crate::task;

const OPERATION_TIMEOUT: Duration = Duration::from_mins(1);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

enum Response {
	Capabilities(DesktopCapabilities),
	Displays(Vec<DesktopDisplay>),
	Windows(Vec<DesktopWindow>),
	Capture(DesktopCapture),
	Unit,
	Snapshot(AxSnapshot),
	Nodes(Vec<AxNode>),
	Node(Option<AxNode>),
	Attributes(Vec<(String, String)>),
}

type Reply = flume::Sender<CoreResult<Response>>;

enum Request {
	PinWindow {
		id:    String,
		pid:   u32,
		reply: Reply,
	},
	Capabilities {
		reply: Reply,
	},
	ListDisplays {
		reply: Reply,
	},
	ListWindows {
		reply: Reply,
	},
	Capture {
		target: Target,
		caps:   CaptureCaps,
		reply:  Reply,
	},
	Click {
		target:  Target,
		x:       f64,
		y:       f64,
		options: ParsedPointerOptions,
		reply:   Reply,
	},
	MoveMouse {
		target: Target,
		x:      f64,
		y:      f64,
		mode:   DeliveryMode,
		reply:  Reply,
	},
	Drag {
		target:  Target,
		path:    Vec<(f64, f64)>,
		options: ParsedPointerOptions,
		reply:   Reply,
	},
	Scroll {
		target: Target,
		x:      f64,
		y:      f64,
		dx:     f64,
		dy:     f64,
		mode:   DeliveryMode,
		reply:  Reply,
	},
	TypeText {
		target: Target,
		text:   String,
		mode:   DeliveryMode,
		reply:  Reply,
	},
	KeyChord {
		target: Target,
		keys:   Vec<keys::KeyName>,
		mode:   DeliveryMode,
		reply:  Reply,
	},
	RaiseWindow {
		id:    String,
		reply: Reply,
	},
	SetWindowFrame {
		id:     String,
		x:      f64,
		y:      f64,
		width:  f64,
		height: f64,
		reply:  Reply,
	},
	InvokeMenu {
		id:    String,
		path:  Vec<String>,
		mode:  DeliveryMode,
		reply: Reply,
	},
	AxSnapshot {
		target:  Target,
		options: AxSnapshotOptions,
		reply:   Reply,
	},
	AxQuery {
		target: Target,
		query:  AxQuery,
		reply:  Reply,
	},
	AxElementAt {
		target: Target,
		x:      f64,
		y:      f64,
		reply:  Reply,
	},
	AxFocused {
		reply: Reply,
	},
	AxNode {
		reference: String,
		reply:     Reply,
	},
	AxAttributes {
		reference: String,
		reply:     Reply,
	},
	AxChildren {
		reference: String,
		reply:     Reply,
	},
	AxParent {
		reference: String,
		reply:     Reply,
	},
	AxPerform {
		reference: String,
		action:    String,
		reply:     Reply,
	},
	AxSetValue {
		reference: String,
		value:     String,
		reply:     Reply,
	},
	AxInsertText {
		reference: String,
		text:      String,
		reply:     Reply,
	},
	AxFocus {
		reference: String,
		reply:     Reply,
	},
	AxClick {
		reference: String,
		options:   ParsedPointerOptions,
		reply:     Reply,
	},
	Close {
		reply: Reply,
	},
}

impl Request {
	fn reply(self, result: CoreResult<Response>) {
		let reply = match self {
			Self::Capabilities { reply }
			| Self::PinWindow { reply, .. }
			| Self::ListDisplays { reply }
			| Self::ListWindows { reply }
			| Self::Capture { reply, .. }
			| Self::Click { reply, .. }
			| Self::MoveMouse { reply, .. }
			| Self::Drag { reply, .. }
			| Self::Scroll { reply, .. }
			| Self::TypeText { reply, .. }
			| Self::KeyChord { reply, .. }
			| Self::RaiseWindow { reply, .. }
			| Self::SetWindowFrame { reply, .. }
			| Self::InvokeMenu { reply, .. }
			| Self::AxSnapshot { reply, .. }
			| Self::AxQuery { reply, .. }
			| Self::AxElementAt { reply, .. }
			| Self::AxFocused { reply }
			| Self::AxNode { reply, .. }
			| Self::AxAttributes { reply, .. }
			| Self::AxChildren { reply, .. }
			| Self::AxParent { reply, .. }
			| Self::AxPerform { reply, .. }
			| Self::AxSetValue { reply, .. }
			| Self::AxInsertText { reply, .. }
			| Self::AxFocus { reply, .. }
			| Self::AxClick { reply, .. }
			| Self::Close { reply } => reply,
		};
		let _ = reply.send(result);
	}

	const fn is_close(&self) -> bool {
		matches!(self, Self::Close { .. })
	}
}

#[derive(Clone, Copy)]
struct ParsedPointerOptions {
	button:    MouseButton,
	count:     u32,
	modifiers: backend::Modifiers,
	mode:      DeliveryMode,
}
impl ParsedPointerOptions {
	fn parse(options: Option<PointerOptions>) -> CoreResult<Self> {
		let options = options.unwrap_or_default();
		Ok(Self {
			button:    MouseButton::parse(options.button.as_deref())?,
			count:     options.count.unwrap_or(1).max(1),
			modifiers: parse_modifiers(options.modifiers.as_deref().unwrap_or_default())?,
			mode:      DeliveryMode::parse(options.delivery_mode.as_deref()),
		})
	}
}

struct Worker {
	backend:      CoreResult<Box<dyn Backend>>,
	registry:     AxRegistry,
	frames:       HashMap<String, FrameGeometry>,
	capabilities: Arc<Mutex<DesktopCapabilities>>,
	pins:         WindowPins,
}

impl Worker {
	fn new(selector: DisplaySelector, capabilities: Arc<Mutex<DesktopCapabilities>>) -> Self {
		let backend = create_backend(selector);
		Self {
			backend,
			registry: AxRegistry::default(),
			frames: HashMap::new(),
			capabilities,
			pins: WindowPins::default(),
		}
	}

	fn backend(&mut self) -> CoreResult<&mut Box<dyn Backend>> {
		self.backend.as_mut().map_err(|error| error.clone())
	}

	fn window(&mut self, target: &Target) -> CoreResult<DesktopWindow> {
		let windows = self.backend()?.windows()?;
		let window = match target {
			Target::Window(id) => windows
				.into_iter()
				.find(|window| window.id == *id)
				.ok_or_else(|| DesktopError::window_not_found(format!("window '{id}' was not found"))),
			Target::Desktop => windows
				.into_iter()
				.find(|window| window.focused)
				.ok_or_else(|| DesktopError::window_not_found("no focused window was found")),
		}?;
		self.pins.validate(&window)?;
		Ok(window)
	}

	fn frame(&self, target: &Target) -> CoreResult<FrameGeometry> {
		self.frames.get(target.key()).cloned().ok_or_else(|| {
			DesktopError::invalid_coordinate_frame(format!(
				"no capture of '{}' yet — take a screenshot of this target first; coordinate input is \
				 in pixels of that screenshot",
				target.key()
			))
		})
	}

	fn map_point(
		&mut self,
		target: &Target,
		x: f64,
		y: f64,
	) -> CoreResult<(f64, f64, FrameGeometry)> {
		let frame = self.frame(target)?;
		let current = if matches!(target, Target::Window(_)) {
			Some(self.window(target)?)
		} else {
			None
		};
		let (x, y) = frame.map_point(x, y, current.as_ref())?;
		Ok((x, y, frame))
	}

	fn ax(&mut self) -> CoreResult<&mut dyn backend::AxBackend> {
		self
			.backend()?
			.ax()
			.ok_or_else(DesktopError::ax_unsupported)
	}

	fn resolve_ref(&mut self, reference: &str) -> CoreResult<ax::AxHandle> {
		let handle = self.registry.resolve(reference)?;
		let target = Target::parse(&self.registry.target(reference)?);
		if self.pins.contains(target.key()) {
			let window = self.window(&target)?;
			self.ax()?.validate_owner(&handle, &window)?;
		}
		Ok(handle)
	}

	fn process(&mut self, request: &Request) -> CoreResult<Response> {
		match request {
			Request::PinWindow { id, pid, .. } => {
				let window = self.window(&Target::Window(id.clone()))?;
				if window.pid != Some(*pid) {
					return Err(DesktopError::window_not_found(
						"window no longer belongs to the requested process",
					));
				}
				self.backend()?.pin_window(id, *pid)?;
				self.pins.pin(id, *pid)?;
				Ok(Response::Unit)
			},
			Request::InvokeMenu { id, path, mode, .. } => {
				if *mode != DeliveryMode::Foreground {
					return Err(DesktopError::background_unavailable(
						"menu invocation requires explicit foreground delivery",
					));
				}
				let window = self.window(&Target::Window(id.clone()))?;
				self.backend()?.invoke_menu(&window, path)?;
				self.frames.clear();
				Ok(Response::Unit)
			},
			Request::Capabilities { .. } => {
				let caps = match self.backend.as_mut() {
					Ok(backend) => backend.capabilities(),
					Err(_) => DesktopCapabilities::unavailable(),
				};
				*self.capabilities.lock() = caps.clone();
				Ok(Response::Capabilities(caps))
			},
			Request::ListDisplays { .. } => Ok(Response::Displays(self.backend()?.displays()?)),
			Request::ListWindows { .. } => Ok(Response::Windows(self.backend()?.windows()?)),
			Request::Capture { target, caps, .. } => {
				let (image, mut geometry) = self.backend()?.capture(target, caps)?;
				let source_width = image.width();
				let source_height = image.height();
				let image = apply_capture_caps(image, &mut geometry, caps)?;
				let width = image.width();
				let height = image.height();
				let source = match target {
					Target::Desktop => self.backend()?.displays()?,
					Target::Window(_) => {
						let w = self.window(target)?;
						vec![DesktopDisplay {
							id:           w.id,
							name:         format!("{} — {}", w.app, w.title),
							x:            w.x,
							y:            w.y,
							width:        w.width,
							height:       w.height,
							scale:        f64::from(width) / f64::from(w.width.max(1)),
							pixel_x:      0,
							pixel_y:      0,
							pixel_width:  width,
							pixel_height: height,
							is_primary:   false,
						}]
					},
				};
				let displays = geometry.display_metadata(&source);
				let png = encode_png(image)?;
				self.frames.insert(target.key().to_string(), geometry);
				let capabilities = self.backend()?.capabilities();
				*self.capabilities.lock() = capabilities.clone();
				Ok(Response::Capture(DesktopCapture {
					data: Uint8Array::from(png),
					width,
					height,
					source_width,
					source_height,
					target: target.key().to_string(),
					displays,
					backend: capabilities.backend,
					display_server: capabilities.display_server,
				}))
			},
			Request::Click { target, x, y, options, .. } => {
				let (x, y, frame) = self.map_point(target, *x, *y)?;
				self.backend()?.pointer(
					target,
					PointerEvent::Click {
						x,
						y,
						button: options.button,
						count: options.count,
						modifiers: options.modifiers,
					},
					&frame,
					options.mode,
				)?;
				Ok(Response::Unit)
			},
			Request::MoveMouse { target, x, y, mode, .. } => {
				let (x, y, frame) = self.map_point(target, *x, *y)?;
				self
					.backend()?
					.pointer(target, PointerEvent::Move { x, y }, &frame, *mode)?;
				Ok(Response::Unit)
			},
			Request::Drag { target, path, options, .. } => {
				let frame = self.frame(target)?;
				let current = if matches!(target, Target::Window(_)) {
					Some(self.window(target)?)
				} else {
					None
				};
				let mapped = path
					.iter()
					.map(|(x, y)| frame.map_point(*x, *y, current.as_ref()))
					.collect::<CoreResult<Vec<_>>>()?;
				self.backend()?.pointer(
					target,
					PointerEvent::Drag {
						path:      mapped,
						button:    options.button,
						modifiers: options.modifiers,
					},
					&frame,
					options.mode,
				)?;
				Ok(Response::Unit)
			},
			Request::Scroll { target, x, y, dx, dy, mode, .. } => {
				let (x, y, frame) = self.map_point(target, *x, *y)?;
				self.backend()?.pointer(
					target,
					PointerEvent::Scroll { x, y, dx: *dx, dy: *dy },
					&frame,
					*mode,
				)?;
				Ok(Response::Unit)
			},
			Request::TypeText { target, text, mode, .. } => {
				self.backend()?.type_text(target, text, *mode)?;
				Ok(Response::Unit)
			},
			Request::KeyChord { target, keys, mode, .. } => {
				self.backend()?.key_chord(target, keys, *mode)?;
				Ok(Response::Unit)
			},
			Request::RaiseWindow { id, .. } => {
				self.backend()?.raise_window(id)?;
				Ok(Response::Unit)
			},
			Request::SetWindowFrame { id, x, y, width, height, .. } => {
				if !x.is_finite()
					|| !y.is_finite()
					|| !width.is_finite()
					|| !height.is_finite()
					|| *width <= 0.0
					|| *height <= 0.0
				{
					return Err(DesktopError::ax_failed(
						"window geometry must be finite with positive dimensions",
					));
				}
				let window = self.window(&Target::Window(id.clone()))?;
				// A partial platform failure may already have changed geometry.
				self.frames.clear();
				self
					.backend()?
					.set_window_frame(&window, *x, *y, *width, *height)?;
				Ok(Response::Unit)
			},
			Request::AxSnapshot { target, options, .. } => {
				let window = self.window(target)?;
				let (backend, registry) = (&mut self.backend, &mut self.registry);
				let ax = backend
					.as_mut()
					.map_err(|error| error.clone())?
					.ax()
					.ok_or_else(DesktopError::ax_unsupported)?;
				Ok(Response::Snapshot(ax::snapshot(ax, registry, &window, options)?))
			},
			Request::AxQuery { target, query, .. } => {
				let window = self.window(target)?;
				let (backend, registry) = (&mut self.backend, &mut self.registry);
				let ax = backend
					.as_mut()
					.map_err(|error| error.clone())?
					.ax()
					.ok_or_else(DesktopError::ax_unsupported)?;
				Ok(Response::Nodes(ax::query(ax, registry, &window, query)?))
			},
			Request::AxElementAt { target, x, y, .. } => {
				if let Target::Window(_) = target {
					self.window(target)?;
				}
				let (backend, registry) = (&mut self.backend, &mut self.registry);
				let backend = backend
					.as_mut()
					.map_err(|error| error.clone())?
					.ax()
					.ok_or_else(DesktopError::ax_unsupported)?;
				let node = ax::element_at_node(backend, registry, target.key(), *x, *y)?;
				if let Some(node) = &node {
					self.resolve_ref(&node.ref_)?;
				}
				Ok(Response::Node(node))
			},
			Request::AxFocused { .. } => {
				let handle = self.ax()?.focused_element()?;
				let node = match handle {
					Some(h) => {
						let (backend, registry) = (&mut self.backend, &mut self.registry);
						let ax = backend
							.as_mut()
							.map_err(|error| error.clone())?
							.ax()
							.ok_or_else(DesktopError::ax_unsupported)?;
						Some(register_node(ax, registry, "desktop", h)?)
					},
					None => None,
				};
				Ok(Response::Node(node))
			},
			Request::AxNode { reference, .. } => {
				let h = self.resolve_ref(reference)?;
				let props = self.ax()?.props(&h)?;
				Ok(Response::Node(Some(axnode(reference.clone(), props))))
			},
			Request::AxAttributes { reference, .. } => {
				let h = self.resolve_ref(reference)?;
				let attributes = self.ax()?.attributes(&h)?;
				Ok(Response::Attributes(attributes))
			},
			Request::AxChildren { reference, .. } => {
				let h = self.resolve_ref(reference)?;
				let target = self.registry.target(reference)?;
				let handles = self.ax()?.children(&h)?;
				let mut nodes = Vec::with_capacity(handles.len());
				for h in handles {
					let (backend, registry) = (&mut self.backend, &mut self.registry);
					let ax = backend
						.as_mut()
						.map_err(|error| error.clone())?
						.ax()
						.ok_or_else(DesktopError::ax_unsupported)?;
					nodes.push(register_node(ax, registry, &target, h)?);
				}
				Ok(Response::Nodes(nodes))
			},
			Request::AxParent { reference, .. } => {
				let h = self.resolve_ref(reference)?;
				let target = self.registry.target(reference)?;
				let parent = self.ax()?.parent(&h)?;
				let node = match parent {
					Some(h) => {
						if self.pins.contains(&target) {
							let window = self.window(&Target::parse(&target))?;
							if self.ax()?.validate_owner(&h, &window).is_err() {
								// Parent navigation stops at the exact window boundary.
								return Ok(Response::Node(None));
							}
						}
						let (backend, registry) = (&mut self.backend, &mut self.registry);
						let ax = backend
							.as_mut()
							.map_err(|error| error.clone())?
							.ax()
							.ok_or_else(DesktopError::ax_unsupported)?;
						Some(register_node(ax, registry, &target, h)?)
					},
					None => None,
				};
				Ok(Response::Node(node))
			},
			Request::AxPerform { reference, action, .. } => {
				let h = self.resolve_ref(reference)?;
				if action.eq_ignore_ascii_case("press") {
					ax::ax_press(self.ax()?, &h)?;
				} else {
					self.ax()?.perform(&h, action)?;
				}
				Ok(Response::Unit)
			},
			Request::AxSetValue { reference, value, .. } => {
				let h = self.resolve_ref(reference)?;
				self.ax()?.set_value(&h, value)?;
				Ok(Response::Unit)
			},
			Request::AxInsertText { reference, text, .. } => {
				let h = self.resolve_ref(reference)?;
				self.frames.clear();
				self.ax()?.insert_text(&h, text)?;
				Ok(Response::Unit)
			},
			Request::AxFocus { reference, .. } => {
				let h = self.resolve_ref(reference)?;
				self.ax()?.focus(&h)?;
				Ok(Response::Unit)
			},
			Request::AxClick { reference, options, .. } => {
				let h = self.resolve_ref(reference)?;
				let bounds = self.ax()?.props(&h)?.bounds.ok_or_else(|| {
					DesktopError::ax_failed(format!("{reference} has no clickable bounds"))
				})?;
				let x = bounds.x + bounds.width / 2.0;
				let y = bounds.y + bounds.height / 2.0;
				let target = Target::parse(&self.registry.target(reference)?);
				if matches!(target, Target::Desktop) {
					return Err(DesktopError::invalid_target(
						"pointer actions require a window-scoped AX reference; observe the exact window",
					));
				}
				// An occluding window may contain the same point. The retained
				// reference's owner, never screen overlap, determines delivery.
				let window = self.window(&target)?;
				if !x.is_finite()
					|| !y.is_finite()
					|| x < f64::from(window.x)
					|| x >= f64::from(window.x) + f64::from(window.width)
					|| y < f64::from(window.y)
					|| y >= f64::from(window.y) + f64::from(window.height)
				{
					return Err(DesktopError::invalid_target(format!(
						"{reference} lies outside its owning window; refresh the observation"
					)));
				}
				self.backend()?.pointer(
					&target,
					PointerEvent::Click {
						x,
						y,
						button: options.button,
						count: options.count,
						modifiers: options.modifiers,
					},
					&FrameGeometry::identity_global(),
					options.mode,
				)?;
				Ok(Response::Unit)
			},
			Request::Close { .. } => Ok(Response::Unit),
		}
	}
}

fn axnode(reference: String, props: ax::AxProps) -> AxNode {
	let (x, y, width, height) = props
		.bounds
		.map_or((None, None, None, None), |b| (Some(b.x), Some(b.y), Some(b.width), Some(b.height)));
	AxNode {
		ref_: reference,
		role: props.role,
		native_role: props.native_role,
		title: props.title,
		value: props.value,
		description: props.description,
		enabled: props.enabled,
		focused: props.focused,
		x,
		y,
		width,
		height,
		actions: (!props.actions.is_empty()).then_some(props.actions),
		child_count: props.child_count,
	}
}

#[cfg(target_os = "macos")]
fn create_backend(selector: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	Ok(Box::new(macos::MacosBackend::new(selector)?))
}
#[cfg(target_os = "windows")]
fn create_backend(selector: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	Ok(Box::new(win32::Win32Backend::new(selector)?))
}
#[cfg(target_os = "linux")]
fn create_backend(selector: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	linux::new_backend(selector)
}
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn create_backend(_: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	Err(DesktopError::capture_failed("desktop backend unavailable on this platform"))
}

struct Lifecycle {
	tx:     Option<flume::Sender<Request>>,
	done:   Option<flume::Receiver<()>>,
	join:   Option<JoinHandle<()>>,
	closed: bool,
}
struct SessionCore {
	selector:     DisplaySelector,
	lifecycle:    Mutex<Lifecycle>,
	capabilities: Arc<Mutex<DesktopCapabilities>>,
}
impl SessionCore {
	fn new(selector: DisplaySelector) -> Arc<Self> {
		Arc::new(Self {
			selector,
			lifecycle: Mutex::new(Lifecycle {
				tx:     None,
				done:   None,
				join:   None,
				closed: false,
			}),
			capabilities: Arc::new(Mutex::new(DesktopCapabilities::unavailable())),
		})
	}

	fn ensure_started(&self) -> CoreResult<flume::Sender<Request>> {
		let mut lifecycle = self.lifecycle.lock();
		if lifecycle.closed {
			return Err(DesktopError::closed());
		}
		if let Some(tx) = &lifecycle.tx {
			return Ok(tx.clone());
		}
		let (tx, rx) = flume::unbounded::<Request>();
		let (done_tx, done_rx) = flume::bounded(1);
		let selector = self.selector.clone();
		let caps = Arc::clone(&self.capabilities);
		let join = thread::Builder::new()
			.name("omp-desktop-session".into())
			.spawn(move || {
				let mut worker = Worker::new(selector, caps);
				while let Ok(request) = rx.recv() {
					let close = request.is_close();
					let result = std::panic::catch_unwind(AssertUnwindSafe(|| worker.process(&request)))
						.unwrap_or_else(|_| {
							Err(DesktopError::internal("native desktop worker panicked"))
						});
					request.reply(result);
					if close {
						break;
					}
				}
				let _ = done_tx.send(());
			})
			.map_err(|e| {
				DesktopError::internal(format!("failed to start native desktop worker: {e}"))
			})?;
		lifecycle.tx = Some(tx.clone());
		lifecycle.done = Some(done_rx);
		lifecycle.join = Some(join);
		Ok(tx)
	}

	fn call(&self, make: impl FnOnce(Reply) -> Request) -> CoreResult<Response> {
		let (txr, rxr) = flume::bounded(1);
		self
			.ensure_started()?
			.send(make(txr))
			.map_err(|_| DesktopError::internal("native desktop worker stopped unexpectedly"))?;
		rxr.recv_timeout(OPERATION_TIMEOUT).map_err(|e| {
			DesktopError::timeout(format!("native desktop operation did not complete: {e}"))
		})?
	}

	fn close(&self) -> CoreResult<()> {
		let mut lifecycle = self.lifecycle.lock();
		lifecycle.closed = true;
		let Some(tx) = lifecycle.tx.take() else {
			return Ok(());
		};
		let (rtx, rrx) = flume::bounded(1);
		tx.send(Request::Close { reply: rtx })
			.map_err(|_| DesktopError::closed())?;
		let _ = rrx.recv_timeout(CLOSE_TIMEOUT).map_err(|e| {
			DesktopError::timeout(format!("timed out closing native desktop worker: {e}"))
		})?;
		if let Some(done) = lifecycle.done.take() {
			done.recv_timeout(CLOSE_TIMEOUT).map_err(|e| {
				DesktopError::timeout(format!("native desktop worker did not exit: {e}"))
			})?;
		}
		if let Some(join) = lifecycle.join.take() {
			join
				.join()
				.map_err(|_| DesktopError::internal("native desktop worker panicked during close"))?;
		}
		Ok(())
	}
}
impl Drop for SessionCore {
	fn drop(&mut self) {
		let lifecycle = self.lifecycle.get_mut();
		if let Some(tx) = lifecycle.tx.take() {
			let (reply, _) = flume::bounded(1);
			let _ = tx.send(Request::Close { reply });
		}
		let _ = lifecycle.join.take();
	}
}

fn response_unit(response: Response) -> CoreResult<()> {
	if matches!(response, Response::Unit) {
		Ok(())
	} else {
		Err(DesktopError::internal("unexpected desktop worker response"))
	}
}

/// Persistent, serialized native desktop capture/input/accessibility session.
#[napi]
pub struct DesktopSession {
	core: Arc<SessionCore>,
}
#[napi]
impl DesktopSession {
	/// Pin this native window's owner for the lifetime of the session.
	#[napi]
	pub fn pin_window(&self, id: String, pid: u32) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.pinWindow", move |reply| Request::PinWindow { id, pid, reply }))
	}

	#[napi(constructor)]
	pub fn new(options: Option<DesktopSessionOptions>) -> Result<Self> {
		Ok(Self { core: SessionCore::new(DisplaySelector::parse(options.and_then(|o| o.display))) })
	}

	#[napi(getter)]
	pub fn capabilities(&self) -> DesktopCapabilities {
		match self.core.call(|reply| Request::Capabilities { reply }) {
			Ok(Response::Capabilities(c)) => c,
			_ => self.core.capabilities.lock().clone(),
		}
	}

	#[napi]
	pub fn list_displays(&self) -> Result<task::Promise<Vec<DesktopDisplay>>> {
		let c = Arc::clone(&self.core);
		Ok(task::blocking("desktop.listDisplays", (), move |_| {
			match c.call(|reply| Request::ListDisplays { reply })? {
				Response::Displays(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn list_windows(&self) -> Result<task::Promise<Vec<DesktopWindow>>> {
		let c = Arc::clone(&self.core);
		Ok(task::blocking("desktop.listWindows", (), move |_| {
			match c.call(|reply| Request::ListWindows { reply })? {
				Response::Windows(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn capture(
		&self,
		target: String,
		caps: Option<CaptureCaps>,
	) -> Result<task::Promise<DesktopCapture>> {
		let c = Arc::clone(&self.core);
		let target = Target::parse(&target);
		Ok(task::blocking("desktop.capture", (), move |_| {
			match c.call(|reply| Request::Capture { target, caps: caps.unwrap_or_default(), reply })? {
				Response::Capture(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn click(
		&self,
		target: String,
		x: f64,
		y: f64,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let o = ParsedPointerOptions::parse(opts).map_err(napi::Error::from)?;
		Ok(self.unit("desktop.click", move |reply| Request::Click {
			target: Target::parse(&target),
			x,
			y,
			options: o,
			reply,
		}))
	}

	#[napi]
	pub fn move_mouse(
		&self,
		target: String,
		x: f64,
		y: f64,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let mode = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.mode;
		Ok(self.unit("desktop.moveMouse", move |reply| Request::MoveMouse {
			target: Target::parse(&target),
			x,
			y,
			mode,
			reply,
		}))
	}

	#[napi]
	pub fn drag(
		&self,
		target: String,
		path: Vec<DesktopPoint>,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let o = ParsedPointerOptions::parse(opts).map_err(napi::Error::from)?;
		let path = path.into_iter().map(|p| (p.x, p.y)).collect();
		Ok(self.unit("desktop.drag", move |reply| Request::Drag {
			target: Target::parse(&target),
			path,
			options: o,
			reply,
		}))
	}

	#[napi]
	pub fn scroll(
		&self,
		target: String,
		x: f64,
		y: f64,
		dx: f64,
		dy: f64,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let mode = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.mode;
		Ok(self.unit("desktop.scroll", move |reply| Request::Scroll {
			target: Target::parse(&target),
			x,
			y,
			dx,
			dy,
			mode,
			reply,
		}))
	}

	#[napi]
	pub fn type_text(
		&self,
		target: String,
		text: String,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let mode = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.mode;
		Ok(self.unit("desktop.typeText", move |reply| Request::TypeText {
			target: Target::parse(&target),
			text,
			mode,
			reply,
		}))
	}

	#[napi]
	pub fn key_chord(
		&self,
		target: String,
		keys: Vec<String>,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let keys = parse_keys(&keys).map_err(napi::Error::from)?;
		let mode = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.mode;
		Ok(self.unit("desktop.keyChord", move |reply| Request::KeyChord {
			target: Target::parse(&target),
			keys,
			mode,
			reply,
		}))
	}

	#[napi]
	pub fn raise_window(&self, window_id: String) -> Result<task::Promise<()>> {
		Ok(self
			.unit("desktop.raiseWindow", move |reply| Request::RaiseWindow { id: window_id, reply }))
	}

	#[napi]
	pub fn set_window_frame(
		&self,
		window_id: String,
		x: f64,
		y: f64,
		width: f64,
		height: f64,
	) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.setWindowFrame", move |reply| Request::SetWindowFrame {
			id: window_id,
			x,
			y,
			width,
			height,
			reply,
		}))
	}

	#[napi]
	pub fn invoke_menu(
		&self,
		window_id: String,
		menu_path: Vec<String>,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		if menu_path.is_empty() || menu_path.iter().any(String::is_empty) {
			return Err(
				DesktopError::invalid_target("menu path must contain exact nonempty labels").into(),
			);
		}
		let mode = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.mode;
		Ok(self.unit("desktop.invokeMenu", move |reply| Request::InvokeMenu {
			id: window_id,
			path: menu_path,
			mode,
			reply,
		}))
	}

	#[napi]
	pub fn ax_snapshot(
		&self,
		target: String,
		opts: Option<AxSnapshotOptions>,
	) -> Result<task::Promise<AxSnapshot>> {
		let c = Arc::clone(&self.core);
		Ok(task::blocking("desktop.axSnapshot", (), move |_| {
			match c.call(|reply| Request::AxSnapshot {
				target: Target::parse(&target),
				options: opts.unwrap_or_default(),
				reply,
			})? {
				Response::Snapshot(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn ax_query(&self, target: String, query: AxQuery) -> Result<task::Promise<Vec<AxNode>>> {
		Ok(self.nodes("desktop.axQuery", move |reply| Request::AxQuery {
			target: Target::parse(&target),
			query,
			reply,
		}))
	}

	/// Accessibility hit-test at global logical desktop coordinates; needs no
	/// prior capture.
	#[napi]
	pub fn ax_element_at(
		&self,
		target: String,
		x: f64,
		y: f64,
	) -> Result<task::Promise<Option<AxNode>>> {
		Ok(self.node("desktop.axElementAt", move |reply| Request::AxElementAt {
			target: Target::parse(&target),
			x,
			y,
			reply,
		}))
	}

	#[napi]
	pub fn ax_focused(&self) -> Result<task::Promise<Option<AxNode>>> {
		Ok(self.node("desktop.axFocused", move |reply| Request::AxFocused { reply }))
	}

	#[napi]
	pub fn ax_node(&self, reference: String) -> Result<task::Promise<AxNode>> {
		let c = Arc::clone(&self.core);
		Ok(task::blocking("desktop.axNode", (), move |_| {
			match c.call(|reply| Request::AxNode { reference, reply })? {
				Response::Node(Some(v)) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn ax_attributes(&self, reference: String) -> Result<task::Promise<Vec<(String, String)>>> {
		let c = Arc::clone(&self.core);
		Ok(task::blocking("desktop.axAttributes", (), move |_| {
			match c.call(|reply| Request::AxAttributes { reference, reply })? {
				Response::Attributes(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn ax_children(&self, reference: String) -> Result<task::Promise<Vec<AxNode>>> {
		Ok(self.nodes("desktop.axChildren", move |reply| Request::AxChildren { reference, reply }))
	}

	#[napi]
	pub fn ax_parent(&self, reference: String) -> Result<task::Promise<Option<AxNode>>> {
		Ok(self.node("desktop.axParent", move |reply| Request::AxParent { reference, reply }))
	}

	#[napi]
	pub fn ax_perform(&self, reference: String, action: String) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.axPerform", move |reply| Request::AxPerform {
			reference,
			action,
			reply,
		}))
	}

	#[napi]
	pub fn ax_set_value(&self, reference: String, value: String) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.axSetValue", move |reply| Request::AxSetValue {
			reference,
			value,
			reply,
		}))
	}

	#[napi]
	pub fn ax_insert_text(&self, reference: String, text: String) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.axInsertText", move |reply| Request::AxInsertText {
			reference,
			text,
			reply,
		}))
	}

	#[napi]
	pub fn ax_focus(&self, reference: String) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.axFocus", move |reply| Request::AxFocus { reference, reply }))
	}

	#[napi]
	pub fn ax_click(
		&self,
		reference: String,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let o = ParsedPointerOptions::parse(opts).map_err(napi::Error::from)?;
		Ok(self.unit("desktop.axClick", move |reply| Request::AxClick {
			reference,
			options: o,
			reply,
		}))
	}

	#[napi]
	pub fn close(&self) -> task::Promise<()> {
		let c = Arc::clone(&self.core);
		task::blocking("desktop.close", (), move |_| c.close().map_err(Into::into))
	}
}
impl DesktopSession {
	fn unit(
		&self,
		label: &'static str,
		make: impl FnOnce(Reply) -> Request + Send + 'static,
	) -> task::Promise<()> {
		let c = Arc::clone(&self.core);
		task::blocking(label, (), move |_| c.call(make).and_then(response_unit).map_err(Into::into))
	}

	fn nodes(
		&self,
		label: &'static str,
		make: impl FnOnce(Reply) -> Request + Send + 'static,
	) -> task::Promise<Vec<AxNode>> {
		let c = Arc::clone(&self.core);
		task::blocking(label, (), move |_| {
			match c.call(make)? {
				Response::Nodes(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		})
	}

	fn node(
		&self,
		label: &'static str,
		make: impl FnOnce(Reply) -> Request + Send + 'static,
	) -> task::Promise<Option<AxNode>> {
		let c = Arc::clone(&self.core);
		task::blocking(label, (), move |_| {
			match c.call(make)? {
				Response::Node(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		})
	}
}

#[cfg(test)]
mod capture_tests {
	use image::RgbaImage;

	use super::*;
	use crate::desktop::{
		backend::{AxBackend, Backend},
		error::ErrorCode,
		keys::KeyName,
	};

	const WAYLAND_ID: &str = "atspi::1.31:/org/a11y/atspi/accessible/1";

	/// Backend that mints a composite AT-SPI window id, mirroring the Wayland
	/// `AtSpiAx` path. Exists to exercise `Worker::process` without a display.
	struct FakeWaylandBackend {
		window: DesktopWindow,
	}

	impl FakeWaylandBackend {
		fn new() -> Self {
			Self {
				window: DesktopWindow {
					id:      WAYLAND_ID.to_string(),
					title:   "Obsidian".to_string(),
					app:     "obsidian".to_string(),
					pid:     Some(1234),
					x:       0,
					y:       0,
					width:   64,
					height:  48,
					focused: true,
				},
			}
		}
	}

	impl Backend for FakeWaylandBackend {
		fn capabilities(&mut self) -> DesktopCapabilities {
			DesktopCapabilities {
				backend: "wayland".to_string(),
				display_server: Some("wayland".to_string()),
				capture: true,
				..DesktopCapabilities::unavailable()
			}
		}

		fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
			Ok(Vec::new())
		}

		fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
			Ok(vec![self.window.clone()])
		}

		fn capture(
			&mut self,
			target: &Target,
			_caps: &CaptureCaps,
		) -> CoreResult<(RgbaImage, FrameGeometry)> {
			match target {
				Target::Window(id) if id == &self.window.id => {
					let image = RgbaImage::new(self.window.width, self.window.height);
					let geometry =
						FrameGeometry::for_window(&self.window, image.width(), image.height());
					Ok((image, geometry))
				},
				Target::Window(id) => {
					Err(DesktopError::window_not_found(format!("Wayland window {id} not found")))
				},
				Target::Desktop => Err(DesktopError::capture_failed("desktop capture not exercised")),
			}
		}

		fn pointer(
			&mut self,
			_: &Target,
			_: PointerEvent,
			_: &FrameGeometry,
			_: DeliveryMode,
		) -> CoreResult<()> {
			unreachable!("pointer not exercised")
		}

		fn type_text(&mut self, _: &Target, _: &str, _: DeliveryMode) -> CoreResult<()> {
			unreachable!("type_text not exercised")
		}

		fn key_chord(&mut self, _: &Target, _: &[KeyName], _: DeliveryMode) -> CoreResult<()> {
			unreachable!("key_chord not exercised")
		}

		fn raise_window(&mut self, _: &str) -> CoreResult<()> {
			unreachable!("raise_window not exercised")
		}

		fn ax(&mut self) -> Option<&mut dyn AxBackend> {
			None
		}
	}

	fn worker_with(backend: impl Backend + 'static) -> Worker {
		Worker {
			backend:      Ok(Box::new(backend)),
			registry:     AxRegistry::default(),
			frames:       HashMap::new(),
			capabilities: Arc::new(Mutex::new(DesktopCapabilities::unavailable())),
			pins:         WindowPins::default(),
		}
	}

	fn capture_request(target: Target) -> Request {
		let (reply, _rx) = flume::bounded(1);
		Request::Capture { target, caps: CaptureCaps::default(), reply }
	}

	/// Regression for #7701: a composite AT-SPI window id minted by the Wayland
	/// backend's own `windows()` must reach the backend, not be rejected by a
	/// `u64` pre-parse in the shared request path.
	#[test]
	fn capture_accepts_non_numeric_wayland_window_id() {
		let mut worker = worker_with(FakeWaylandBackend::new());
		let response = worker
			.process(&capture_request(Target::Window(WAYLAND_ID.to_string())))
			.expect("wayland window id should be accepted by capture");
		let Response::Capture(capture) = response else {
			panic!("expected a capture response");
		};
		assert_eq!(capture.target, WAYLAND_ID);
		assert_eq!(capture.width, 64);
		assert_eq!(capture.height, 48);
		assert_eq!(capture.backend, "wayland");
	}

	/// Unknown ids still fail — but as `WindowNotFound` from the backend lookup,
	/// never as an `InvalidTarget` pre-parse rejection of a non-`u64` id.
	#[test]
	fn capture_rejects_unknown_window_id_via_backend_lookup() {
		let mut worker = worker_with(FakeWaylandBackend::new());
		let Err(err) = worker.process(&capture_request(Target::Window("does-not-exist".to_string())))
		else {
			panic!("unknown window id should fail");
		};
		assert_eq!(err.code, ErrorCode::WindowNotFound);
	}
}
