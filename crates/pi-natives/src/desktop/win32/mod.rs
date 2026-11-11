#[cfg(target_os = "windows")]
mod ax;
#[cfg(target_os = "windows")]
mod capture;
pub mod delivery;
#[cfg(any(target_os = "windows", test))]
mod geometry;
#[cfg(target_os = "windows")]
mod input;
#[cfg(target_os = "windows")]
mod menus;
#[cfg(any(target_os = "windows", test))]
mod readback;
#[cfg(target_os = "windows")]
mod window;

#[cfg(target_os = "windows")]
use enigo::Enigo;
#[cfg(target_os = "windows")]
use image::RgbaImage;

#[cfg(target_os = "windows")]
use self::ax::Win32Ax;
#[cfg(target_os = "windows")]
use super::ax::AxHandle;
#[cfg(target_os = "windows")]
use super::backend::{
	AxBackend, Backend, DeliveryMode, ElementDelivery, ElementInput, PointerEvent,
};
#[cfg(target_os = "windows")]
use super::control::OperationToken;
#[cfg(target_os = "windows")]
use super::error::{CoreResult, DesktopError};
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
		// Initialize DPI awareness before xcap or input observes desktop
		// geometry, keeping both APIs in the same per-monitor physical
		// coordinate regime.
		let global_input = input::create_global_input()?;
		let _ = capture::displays()?;
		Ok(Self { display, global_input, ax: Win32Ax::new() })
	}
}

#[cfg(target_os = "windows")]
impl Backend for Win32Backend {
	fn capabilities(&mut self) -> DesktopCapabilities {
		let display_count =
			capture::displays().map_or(0, |displays| displays.len().min(u32::MAX as usize) as u32);
		DesktopCapabilities {
			backend: "win32".to_string(),
			display_server: Some("win32".to_string()),
			capture: display_count > 0,
			input: true,
			ax: true,
			background_window_input: true,
			takeover: true,
			applications: super::applications::supported(),
			menus: true,
			held_input: true,
			spaces: false,
			global_escape: true,
			capture_permission: if display_count > 0 {
				"granted"
			} else {
				"unknown"
			}
			.to_string(),
			input_permission: "granted".to_string(),
			ax_permission: "granted".to_string(),
			display_count,
			screen_locked: false,
			display_asleep: false,
		}
	}

	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
		capture::displays()
	}

	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
		capture::windows()
	}

	fn capture(
		&mut self,
		target: &Target,
		_caps: &CaptureCaps,
		selector: Option<&DisplaySelector>,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		let explicit = target.display_selector();
		capture::capture(selector.or(explicit.as_ref()).unwrap_or(&self.display), target)
	}

	fn pointer(
		&mut self,
		target: &Target,
		event: PointerEvent,
		_frame: &FrameGeometry,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		input::pointer(&mut self.global_input, &mut self.ax, target, event, mode)
	}

	fn type_text(
		&mut self,
		target: &Target,
		text: &str,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		input::type_text(&mut self.ax, target, text, mode)
	}

	fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		input::key_chord(&mut self.global_input, target, keys, mode)
	}

	/// Background keys go straight to the element's own control window,
	/// leaving the window's focus and the foreground alone: UI Automation's
	/// `SetFocus` would bring the window to the front, taking the user's
	/// keyboard. A windowless element (WPF, `WinUI`, web content) has no
	/// window to post to, so background input refuses. Takeover focuses the
	/// element and types through the foreground route.
	fn element_input(
		&mut self,
		element: &AxHandle,
		input: &ElementInput,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<ElementDelivery> {
		token.check()?;
		let windows = capture::windows()?;
		let id = self.ax.window_id(element, &windows)?;
		match mode {
			DeliveryMode::Background => {
				let own = Win32Ax::own_window(element)?.ok_or_else(|| {
					DesktopError::background_unavailable(format!(
						"this element of window {id} is drawn without a control window of its own, so \
						 background keys cannot address it, and focusing it would bring the window to \
						 the front; nothing was sent"
					))
				})?;
				input::element_background(&id, own, input)?;
			},
			DeliveryMode::Foreground | DeliveryMode::ForegroundReturnFocus => {
				let target = Target::Window(id);
				self.ax.focus(element)?;
				match input {
					ElementInput::Text(text) => input::type_text(&mut self.ax, &target, text, mode)?,
					ElementInput::Chord(keys) => {
						input::key_chord(&mut self.global_input, &target, keys, mode)?;
					},
				}
			},
		}
		Ok(ElementDelivery::Delivered)
	}

	fn hold_keys(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		duration: std::time::Duration,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		input::hold_keys(&mut self.global_input, target, keys, duration, mode)
	}

	fn menu_items(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
	) -> CoreResult<Vec<super::menus::DesktopMenuItem>> {
		menus::items(window, path)
	}

	fn menu_select(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		menus::select(window, path)
	}

	fn raise_window(&mut self, id: &str, token: &OperationToken) -> CoreResult<()> {
		token.check()?;
		input::raise_window(id)
	}

	fn ax(&mut self) -> Option<&mut dyn AxBackend> {
		Some(&mut self.ax)
	}
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
	use std::{
		fmt::Write as _,
		process::Command,
		time::{Duration, Instant},
	};

	use uiautomation::{
		UIAutomation,
		patterns::UIValuePattern,
		types::{ControlType, Handle},
	};

	use super::*;
	use crate::desktop::control::CancellationSource;

	/// 240 characters, each block numbered so a dropped one shows.
	fn text() -> String {
		let mut text = (0..30).fold(String::new(), |mut text, k| {
			let _ = write!(text, "t{k:03}-ab ");
			text
		});
		text.truncate(240);
		text
	}

	/// Windows 11 Notepad's window on a new empty file `name`, once its editor
	/// holds keyboard focus.
	fn notepad(backend: &mut Win32Backend, name: &str) -> DesktopWindow {
		let path = std::env::temp_dir().join(name);
		std::fs::write(&path, "").unwrap();
		// Notepad stays open for the test to type into; its launcher may hand
		// the file to a running instance and exit.
		#[expect(clippy::zombie_processes, reason = "Notepad outlives the test")]
		Command::new("notepad.exe").arg(&path).spawn().unwrap();
		let deadline = Instant::now() + Duration::from_secs(20);
		loop {
			let found = backend
				.windows()
				.unwrap()
				.into_iter()
				.find(|window| window.title.starts_with(name) && window.title.ends_with("Notepad"));
			if let Some(window) = found
				&& window::focused_descendant(input_hwnd(&window))
					.is_some_and(|focus| window::class_name(focus) == "RichEditD2DPT")
			{
				return window;
			}
			assert!(Instant::now() < deadline, "Notepad did not open {name} with its editor focused");
			std::thread::sleep(Duration::from_millis(200));
		}
	}

	fn input_hwnd(window: &DesktopWindow) -> windows_sys::Win32::Foundation::HWND {
		std::ptr::with_exposed_provenance_mut(window.id.parse::<usize>().unwrap())
	}

	/// The text of `window`'s editor once two reads 500 ms apart agree.
	fn editor_text(window: &DesktopWindow) -> String {
		let automation = UIAutomation::new().unwrap();
		let root = automation
			.element_from_handle(Handle::from(window.id.parse::<isize>().unwrap()))
			.unwrap();
		let editor = automation
			.create_matcher()
			.from(root)
			.control_type(ControlType::Document)
			.find_first()
			.unwrap();
		let read = || {
			let value = editor
				.get_pattern::<UIValuePattern>()
				.unwrap()
				.get_value()
				.unwrap();
			value.trim_end_matches(['\r', '\n']).to_string()
		};
		let mut last = read();
		loop {
			std::thread::sleep(Duration::from_millis(500));
			let now = read();
			if now == last {
				return now;
			}
			last = now;
		}
	}

	fn type_into_notepad(name: &str) -> (CoreResult<()>, String) {
		let mut backend = Win32Backend::new(DisplaySelector::Active).unwrap();
		let window = notepad(&mut backend, name);
		let token = CancellationSource::default().token();
		let result = backend.type_text(
			&Target::Window(window.id.clone()),
			&text(),
			DeliveryMode::ForegroundReturnFocus,
			&token,
		);
		(result, editor_text(&window))
	}

	#[test]
	#[ignore = "opens Windows 11 Notepad and types into it; run with --ignored in a signed-in \
	            desktop session"]
	fn notepad_gets_typed_text_whole() {
		let (result, got) = type_into_notepad("omp-type-whole.txt");
		assert_eq!(got, text(), "type returned {result:?}");
	}

	#[test]
	#[ignore = "opens Windows 11 Notepad and types into it; run with --ignored in a signed-in \
	            desktop session"]
	fn typing_never_reports_text_notepad_lacks() {
		let (result, got) = type_into_notepad("omp-type-honest.txt");
		assert!(
			result.is_err() || got == text(),
			"type succeeded, but Notepad holds {} of {} characters: {got:?}",
			got.chars().count(),
			text().chars().count()
		);
	}
}
