#[cfg(target_os = "windows")]
mod ax;
#[cfg(target_os = "windows")]
mod capture;
pub mod delivery;
#[cfg(target_os = "windows")]
mod input;

#[cfg(target_os = "windows")]
use enigo::Enigo;
#[cfg(target_os = "windows")]
use image::RgbaImage;

#[cfg(target_os = "windows")]
use self::ax::Win32Ax;
#[cfg(target_os = "windows")]
use super::backend::{AxBackend, Backend, DeliveryMode, PointerEvent};
#[cfg(target_os = "windows")]
use super::error::CoreResult;
#[cfg(target_os = "windows")]
use super::frame::FrameGeometry;
#[cfg(target_os = "windows")]
use super::keys::KeyName;
#[cfg(target_os = "windows")]
use super::types::{
	CaptureCaps, DesktopCapabilities, DesktopDisplay, DesktopWindow, DisplaySelector, Target,
};

#[cfg(target_os = "windows")]
pub(crate) struct Win32Backend {
	display:      DisplaySelector,
	global_input: Enigo,
	ax:           Win32Ax,
}

#[cfg(target_os = "windows")]
impl Win32Backend {
	pub(crate) fn new(display: DisplaySelector) -> CoreResult<Self> {
		// Initialize DPI awareness before xcap or input observes desktop geometry,
		// keeping both APIs in the same per-monitor physical coordinate regime.
		let global_input = input::create_global_input()?;
		let _ = capture::displays(&display)?;
		Ok(Self { display, global_input, ax: Win32Ax::new() })
	}
}

#[cfg(target_os = "windows")]
impl Backend for Win32Backend {
	fn capabilities(&mut self) -> DesktopCapabilities {
		let display_count = capture::displays(&self.display)
			.map_or(0, |displays| displays.len().min(u32::MAX as usize) as u32);
		DesktopCapabilities {
			backend: "win32".to_string(),
			display_server: Some("win32".to_string()),
			capture: display_count > 0,
			input: true,
			ax: true,
			background_window_input: true,
			delivery_modes: vec!["background".to_string(), "foreground".to_string()],
			capture_permission: if display_count > 0 {
				"granted"
			} else {
				"unknown"
			}
			.to_string(),
			input_permission: "granted".to_string(),
			ax_permission: "granted".to_string(),
			display_count,
		}
	}

	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
		capture::displays(&self.display)
	}

	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
		capture::windows()
	}

	fn capture(
		&mut self,
		target: &Target,
		_caps: &CaptureCaps,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		capture::capture(&self.display, target)
	}

	fn pointer(
		&mut self,
		target: &Target,
		event: PointerEvent,
		_frame: &FrameGeometry,
		mode: DeliveryMode,
	) -> CoreResult<()> {
		input::pointer(&mut self.global_input, target, event, mode)
	}

	fn type_text(&mut self, target: &Target, text: &str, mode: DeliveryMode) -> CoreResult<()> {
		input::type_text(&mut self.global_input, target, text, mode)
	}

	fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		mode: DeliveryMode,
	) -> CoreResult<()> {
		input::key_chord(&mut self.global_input, target, keys, mode)
	}

	fn raise_window(&mut self, id: &str) -> CoreResult<()> {
		input::raise_window(id)
	}

	fn set_window_frame(
		&mut self,
		window: &DesktopWindow,
		x: f64,
		y: f64,
		width: f64,
		height: f64,
	) -> CoreResult<()> {
		use windows_sys::Win32::{
			Foundation::RECT,
			UI::WindowsAndMessaging::{
				GetWindowRect, GetWindowThreadProcessId, SWP_NOACTIVATE, SWP_NOOWNERZORDER,
				SWP_NOZORDER, SetWindowPos,
			},
		};

		use super::error::DesktopError;
		let displays = capture::displays(&DisplaySelector::All)?;
		let requested = capture::physical_frame_request(&displays, [x, y, width, height])?;
		let id = window
			.id
			.parse::<u32>()
			.map_err(|_| DesktopError::window_not_found("invalid Win32 window id"))?;
		let hwnd = std::ptr::with_exposed_provenance_mut(id as usize);
		let mut actual_pid = 0;
		// SAFETY: This queries the exact HWND before reading its frame.
		unsafe { GetWindowThreadProcessId(hwnd, &mut actual_pid) };
		super::types::PLATFORM_WINDOW_PINS.with(|pins| {
			pins
				.borrow()
				.validate_identity(&window.id, (actual_pid != 0).then_some(actual_pid))
		})?;
		let visible = capture::physical_window_frame(id)?;
		if capture::contained_frame_scale(&displays, visible)?
			!= capture::contained_frame_scale(&displays, requested)?
		{
			return Err(DesktopError::input_failed(
				"exact window geometry does not support cross-DPI moves because frame insets may \
				 change",
			));
		}
		let mut rect: RECT = unsafe { std::mem::zeroed() };
		// SAFETY: The rectangle is writable and the HWND is the exact target.
		if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
			return Err(DesktopError::input_failed(format!(
				"GetWindowRect failed: {}",
				std::io::Error::last_os_error()
			)));
		}
		// xcap exposes DWM's visible bounds; SetWindowPos instead addresses the
		// outer rectangle including invisible resize borders. Preserve the
		// measured non-client insets on this same-DPI move/resize.
		let outer = [
			i64::from(requested[0]) + i64::from(rect.left) - i64::from(visible[0]),
			i64::from(requested[1]) + i64::from(rect.top) - i64::from(visible[1]),
			i64::from(requested[2]) + i64::from(rect.right)
				- i64::from(rect.left)
				- i64::from(visible[2]),
			i64::from(requested[3]) + i64::from(rect.bottom)
				- i64::from(rect.top)
				- i64::from(visible[3]),
		];
		if outer.iter().any(|value| i32::try_from(*value).is_err())
			|| outer[2] <= 0
			|| outer[3] <= 0
			|| i32::try_from(outer[0] + outer[2]).is_err()
			|| i32::try_from(outer[1] + outer[3]).is_err()
		{
			return Err(DesktopError::input_failed(
				"requested outer window geometry exceeds Win32 range",
			));
		}
		actual_pid = 0;
		// SAFETY: Revalidate the immutable identity immediately before mutation.
		unsafe { GetWindowThreadProcessId(hwnd, &mut actual_pid) };
		super::types::PLATFORM_WINDOW_PINS.with(|pins| {
			pins
				.borrow()
				.validate_identity(&window.id, (actual_pid != 0).then_some(actual_pid))
		})?;
		// SAFETY: The HWND is addressed explicitly; flags forbid activation and z-order
		// changes.
		if unsafe {
			SetWindowPos(
				hwnd,
				std::ptr::null_mut(),
				outer[0] as i32,
				outer[1] as i32,
				outer[2] as i32,
				outer[3] as i32,
				SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER,
			)
		} == 0
		{
			return Err(DesktopError::input_failed(format!(
				"SetWindowPos failed: {}",
				std::io::Error::last_os_error()
			)));
		}
		let actual = capture::physical_window_frame(id)?;
		let displays = capture::displays(&DisplaySelector::All)?;
		actual_pid = 0;
		// SAFETY: Readback must still belong to the pinned target.
		unsafe { GetWindowThreadProcessId(hwnd, &mut actual_pid) };
		super::types::PLATFORM_WINDOW_PINS.with(|pins| {
			pins
				.borrow()
				.validate_identity(&window.id, (actual_pid != 0).then_some(actual_pid))
		})?;
		if capture::logical_window_frame(
			&displays,
			actual[0],
			actual[1],
			actual[2] as u32,
			actual[3] as u32,
		) != (x as i32, y as i32, width as u32, height as u32)
		{
			return Err(DesktopError::input_failed(
				"window did not report the requested logical geometry after SetWindowPos",
			));
		}
		Ok(())
	}

	fn ax(&mut self) -> Option<&mut dyn AxBackend> {
		Some(&mut self.ax)
	}
}
