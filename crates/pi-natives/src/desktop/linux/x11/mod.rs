mod capture;
mod input;

use capture::X11Capture;
use image::RgbaImage;
use input::X11Input;

use crate::desktop::{
	backend::{AxBackend, Backend, DeliveryMode, PointerEvent},
	error::{CoreResult, DesktopError},
	frame::FrameGeometry,
	keys::KeyName,
	types::{
		CaptureCaps, DesktopCapabilities, DesktopDisplay, DesktopWindow, DisplaySelector, Target,
	},
};

pub struct X11Backend {
	capture:        X11Capture,
	input:          X11Input,
	display_server: Option<String>,
}

impl X11Backend {
	pub(crate) fn new(display: DisplaySelector) -> CoreResult<Self> {
		let capture = X11Capture::new(display)?;
		let input = X11Input::new(capture.connection(), capture.root())?;
		Ok(Self { capture, input, display_server: std::env::var("DISPLAY").ok() })
	}
}

impl Backend for X11Backend {
	fn capabilities(&mut self) -> DesktopCapabilities {
		let displays = self.capture.displays();
		DesktopCapabilities {
			backend: "x11".to_string(),
			display_server: self.display_server.clone(),
			capture: displays.is_ok(),
			input: true,
			ax: false,
			background_window_input: true,
			delivery_modes: vec!["background".to_string(), "foreground".to_string()],
			capture_permission: if displays.is_ok() {
				"granted"
			} else {
				"unavailable"
			}
			.to_string(),
			input_permission: "granted".to_string(),
			ax_permission: "unavailable: no exact XID-to-AT-SPI identity association".to_string(),
			display_count: displays.map_or(0, |items| u32::try_from(items.len()).unwrap_or(u32::MAX)),
		}
	}

	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
		self.capture.displays()
	}

	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
		self.capture.windows()
	}

	fn capture(
		&mut self,
		target: &Target,
		_caps: &CaptureCaps,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		self.capture.capture(target)
	}

	fn pointer(
		&mut self,
		target: &Target,
		event: PointerEvent,
		_frame: &FrameGeometry,
		mode: DeliveryMode,
	) -> CoreResult<()> {
		self.input.pointer(target, event, mode)
	}

	fn type_text(&mut self, target: &Target, text: &str, mode: DeliveryMode) -> CoreResult<()> {
		self.input.type_text(target, text, mode)
	}

	fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		mode: DeliveryMode,
	) -> CoreResult<()> {
		self.input.key_chord(target, keys, mode)
	}

	fn raise_window(&mut self, id: &str) -> CoreResult<()> {
		let window = id
			.parse::<u32>()
			.map_err(|_| DesktopError::window_not_found(format!("invalid X11 window id {id}")))?;
		self.input.raise_window(window)
	}

	fn ax(&mut self) -> Option<&mut dyn AxBackend> {
		None
	}
}

fn validate_owner(conn: &x11rb::rust_connection::RustConnection, window: u32) -> CoreResult<()> {
	use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _};
	crate::desktop::types::PLATFORM_WINDOW_PINS.with(|pins| {
		let pins = pins.borrow();
		let id = window.to_string();
		if !pins.contains(&id) {
			return Ok(());
		}
		let atom = conn
			.intern_atom(false, b"_NET_WM_PID")
			.map_err(|err| DesktopError::window_not_found(err.to_string()))?
			.reply()
			.map_err(|err| DesktopError::window_not_found(err.to_string()))?
			.atom;
		let property = conn
			.get_property(false, window, atom, AtomEnum::CARDINAL, 0, 1)
			.map_err(|err| DesktopError::window_not_found(err.to_string()))?
			.reply()
			.map_err(|err| DesktopError::window_not_found(err.to_string()))?;
		pins.validate_identity(&id, property.value32().and_then(|mut values| values.next()))
	})
}
