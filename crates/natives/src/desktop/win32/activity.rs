//! The user's own key and button presses, so a takeover neither starts while
//! the user is typing or clicking nor carries on once they do: from then on
//! the target holds the keyboard, and the user's keys would land in it.
//!
//! Raw Input posts a copy of every keyboard and mouse event to a message-only
//! window of this process wherever the focus is (`RIDEV_INPUTSINK`), naming
//! the device it came from. Input sent with `SendInput`, this process's own
//! included, comes from no device and is never the user's; precision-touchpad
//! and touchscreen presses also come without one, so they go unseen. Unlike a
//! low-level hook, the listener is not in the input path: Windows never waits
//! for it.
//! Only how many presses there were and when the last one was are kept, never
//! which key or button, and pointer moves are not counted.
use std::{
	cell::RefCell,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use parking_lot::Mutex;
use windows_sys::Win32::{
	Foundation::{HWND, LPARAM, LRESULT, WPARAM},
	System::SystemInformation::GetTickCount,
	UI::{
		Input::{
			GetRawInputData, HRAWINPUT,
			KeyboardAndMouse::{
				GetAsyncKeyState, GetLastInputInfo, LASTINPUTINFO, VK_CONTROL, VK_LBUTTON, VK_LWIN,
				VK_MBUTTON, VK_MENU, VK_RBUTTON, VK_RWIN, VK_SHIFT, VK_XBUTTON1, VK_XBUTTON2,
			},
			RAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER, RID_INPUT, RIDEV_INPUTSINK, RIM_TYPEKEYBOARD,
			RIM_TYPEMOUSE, RegisterRawInputDevices,
		},
		WindowsAndMessaging::{
			CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
			HWND_MESSAGE, MSG, RI_KEY_BREAK, RI_MOUSE_BUTTON_4_DOWN, RI_MOUSE_BUTTON_5_DOWN,
			RI_MOUSE_HWHEEL, RI_MOUSE_LEFT_BUTTON_DOWN, RI_MOUSE_MIDDLE_BUTTON_DOWN,
			RI_MOUSE_RIGHT_BUTTON_DOWN, RI_MOUSE_WHEEL, RegisterClassW, WM_INPUT, WNDCLASSW,
		},
	},
};

use crate::desktop::{
	control::{self, USER_QUIET as QUIET},
	error::{CoreResult, DesktopError},
};

const READ_AGAIN: &str =
	"read the window again (win.ax(), win.observe() or win.screenshot()) before acting on it";
/// How often a takeover waiting on a key or button the user holds checks
/// whether they have let go.
const HELD_POLL: Duration = Duration::from_millis(50);
/// Mouse button-downs and wheel turns; moves and button-ups are not presses.
const MOUSE_PRESSES: u32 = RI_MOUSE_LEFT_BUTTON_DOWN
	| RI_MOUSE_RIGHT_BUTTON_DOWN
	| RI_MOUSE_MIDDLE_BUTTON_DOWN
	| RI_MOUSE_BUTTON_4_DOWN
	| RI_MOUSE_BUTTON_5_DOWN
	| RI_MOUSE_WHEEL
	| RI_MOUSE_HWHEEL;
/// Generic desktop usage page and its keyboard and mouse usages.
const USAGE_PAGE: u16 = 1;
const KEYBOARD: u16 = 6;
const MOUSE: u16 = 2;

struct Presses {
	count: AtomicU64,
	last:  Mutex<Option<Instant>>,
}

impl Presses {
	fn record(&self, at: Instant) {
		*self.last.lock() = Some(at);
		self.count.fetch_add(1, Ordering::AcqRel);
	}
}

type Baseline = (Arc<Presses>, u64);

thread_local! {
	/// The listener thread's presses, for its window procedure.
	static LISTENING: RefCell<Option<Arc<Presses>>> = const { RefCell::new(None) };
	/// The press count the worker admitted the next takeover with, on the
	/// thread that sends its input.
	static ADMITTED: RefCell<Option<Baseline>> = const { RefCell::new(None) };
	/// The press count the running takeover compares against ([`check`]).
	static ACTIVE: RefCell<Option<Baseline>> = const { RefCell::new(None) };
}

/// The process's one listener, started by the first session and kept for the
/// process's life: Windows keeps one raw input registration per device kind
/// and process, so a listener stopping while another starts could unregister
/// the new one's devices.
static SHARED: Mutex<Option<Arc<Presses>>> = Mutex::new(None);

/// The user's presses since this process started watching.
pub(super) struct UserActivity {
	presses: Arc<Presses>,
}

impl UserActivity {
	pub(super) fn start() -> CoreResult<Self> {
		let mut shared = SHARED.lock();
		if let Some(presses) = shared.as_ref() {
			return Ok(Self { presses: Arc::clone(presses) });
		}
		let presses = listen()?;
		*shared = Some(Arc::clone(&presses));
		Ok(Self { presses })
	}

	/// Waits until the user has pressed no key and button for [`QUIET`] and
	/// holds none, then makes the press count the current thread's takeover
	/// compares against ([`check`]). Fails without sending anything when the
	/// user is still active shortly before the run's deadline (one quiet
	/// period without one).
	pub(super) fn admit(&self) -> CoreResult<()> {
		ADMITTED.set(None);
		let deadline = control::current_token().and_then(|token| token.deadline());
		let limit = deadline.map_or_else(
			|| Instant::now() + QUIET,
			|deadline| {
				deadline
					.checked_sub(control::DEADLINE_MARGIN)
					.unwrap_or(deadline)
			},
		);
		let count = admit_with(&self.presses, limit, Instant::now, input_held, control::wait)?;
		ADMITTED.set(Some((Arc::clone(&self.presses), count)));
		Ok(())
	}
}

/// With the input lease held: whether the user has pressed nothing since
/// [`UserActivity::admit`] and holds no key or button.
pub(super) fn admitted() -> bool {
	ADMITTED.with_borrow(|admitted| {
		admitted
			.as_ref()
			.is_some_and(|(presses, baseline)| presses.count.load(Ordering::Acquire) == *baseline)
	}) && !input_held()
}

/// Keeps the current thread's takeover watched until dropped.
#[cfg_attr(test, derive(Default))]
pub(super) struct Takeover(());

impl Drop for Takeover {
	fn drop(&mut self) {
		ACTIVE.set(None);
	}
}

/// As a takeover starts, before it brings its target forward: fails once the
/// user has pressed a key or button since the worker admitted it, or holds
/// one. A takeover the worker did not admit is admitted here without waiting:
/// the input lease is held, so a user still active refuses it at once.
pub(super) fn start() -> CoreResult<Takeover> {
	ACTIVE.set(None);
	let baseline = if let Some((presses, baseline)) = ADMITTED.take() {
		if presses.count.load(Ordering::Acquire) != baseline || input_held() {
			return Err(DesktopError::user_intervened(
				"the user pressed or is holding a key or button as the takeover was starting, so none \
				 started; nothing was sent; try again once they pause",
			));
		}
		(presses, baseline)
	} else {
		let Some(presses) = SHARED.lock().clone() else {
			return Err(unwatched());
		};
		let baseline = admit_with(&presses, Instant::now(), Instant::now, input_held, control::wait)?;
		(presses, baseline)
	};
	ACTIVE.set(Some(baseline));
	Ok(Takeover(()))
}

/// Refuses once the user has pressed a key or button since the current
/// thread's takeover started ([`start`]); outside one there is nothing to
/// compare.
pub(super) fn check() -> CoreResult<()> {
	ACTIVE.with_borrow(|active| match active {
		Some((presses, baseline)) if presses.count.load(Ordering::Acquire) != *baseline => {
			Err(DesktopError::user_intervened(format!(
				"the user pressed a key or clicked during this takeover; input sent before that may \
				 already have landed, and nothing more was sent; {READ_AGAIN}"
			)))
		},
		_ => Ok(()),
	})
}

fn unwatched() -> DesktopError {
	DesktopError::input_failed(
		"cannot watch the user's keys and clicks (Raw Input registration failed), so no takeover \
		 started; nothing was sent",
	)
}

fn admit_with(
	presses: &Presses,
	limit: Instant,
	now: impl Fn() -> Instant,
	held: impl Fn() -> bool,
	mut wait: impl FnMut(Duration) -> CoreResult<()>,
) -> CoreResult<u64> {
	loop {
		let holding = held();
		let count = presses.count.load(Ordering::Acquire);
		let now = now();
		let last = if holding {
			Some(now)
		} else {
			*presses.last.lock()
		};
		let Some(last) = last else {
			return Ok(count);
		};
		let idle = now.saturating_duration_since(last);
		if idle >= QUIET {
			return Ok(count);
		}
		if now >= limit {
			return Err(control::still_active_refusal(idle));
		}
		let quiet = (last + QUIET).min(limit).saturating_duration_since(now);
		wait(if holding { HELD_POLL.min(quiet) } else { quiet })?;
	}
}

/// Whether the user holds a mouse button or a modifier, which would change
/// what the takeover's own input does.
fn input_held() -> bool {
	[
		VK_LBUTTON,
		VK_RBUTTON,
		VK_MBUTTON,
		VK_XBUTTON1,
		VK_XBUTTON2,
		VK_SHIFT,
		VK_CONTROL,
		VK_MENU,
		VK_LWIN,
		VK_RWIN,
	]
	.into_iter()
	// SAFETY: GetAsyncKeyState takes a scalar virtual key.
	.any(|key| unsafe { GetAsyncKeyState(key.into()) } < 0)
}

/// When the user last pressed anything before the listener started, from the
/// session's last input time, which counts injected input too.
fn last_input_before(started: Instant) -> Option<Instant> {
	let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
	// SAFETY: `info` is writable and its size is set.
	if unsafe { GetLastInputInfo(&raw mut info) } == 0 {
		return None;
	}
	// SAFETY: GetTickCount has no preconditions; both ticks wrap together.
	let idle = unsafe { GetTickCount() }.wrapping_sub(info.dwTime);
	started.checked_sub(Duration::from_millis(idle.into()))
}

/// Whether `input` is a key or button press from a device, which is the user's.
fn is_user_press(input: &RAWINPUT) -> bool {
	if input.header.hDevice.is_null() {
		return false;
	}
	match input.header.dwType {
		// SAFETY: the header says which member Windows filled.
		RIM_TYPEKEYBOARD => u32::from(unsafe { input.data.keyboard }.Flags) & RI_KEY_BREAK == 0,
		RIM_TYPEMOUSE => {
			// SAFETY: as above.
			let flags = unsafe { input.data.mouse.Anonymous.Anonymous.usButtonFlags };
			u32::from(flags) & MOUSE_PRESSES != 0
		},
		_ => false,
	}
}

unsafe extern "system" fn receive(
	window: HWND,
	message: u32,
	wparam: WPARAM,
	lparam: LPARAM,
) -> LRESULT {
	if message == WM_INPUT {
		let mut input = RAWINPUT::default();
		let mut size = size_of::<RAWINPUT>() as u32;
		// SAFETY: `input` is writable for `size` bytes; keyboard and mouse
		// input, the only kinds registered, fit in a RAWINPUT.
		let read = unsafe {
			GetRawInputData(
				lparam as HRAWINPUT,
				RID_INPUT,
				(&raw mut input).cast(),
				&raw mut size,
				size_of::<RAWINPUTHEADER>() as u32,
			)
		};
		if read != u32::MAX && read != 0 && is_user_press(&input) {
			LISTENING.with_borrow(|presses| {
				if let Some(presses) = presses {
					presses.record(Instant::now());
				}
			});
		}
	}
	// SAFETY: forwards the window procedure's own arguments; WM_INPUT needs it
	// to release the input.
	unsafe { DefWindowProcW(window, message, wparam, lparam) }
}

fn devices(flags: u32, target: HWND) -> [RAWINPUTDEVICE; 2] {
	[KEYBOARD, MOUSE].map(|usage| RAWINPUTDEVICE {
		usUsagePage: USAGE_PAGE,
		usUsage:     usage,
		dwFlags:     flags,
		hwndTarget:  target,
	})
}

fn listen() -> CoreResult<Arc<Presses>> {
	let started = Instant::now();
	let presses =
		Arc::new(Presses { count: AtomicU64::new(0), last: Mutex::new(last_input_before(started)) });
	let (ready, receive_ready) = flume::bounded(1);
	let shared = Arc::clone(&presses);
	let thread = thread::Builder::new()
		.name("desktop-user-input".into())
		.spawn(move || {
			LISTENING.set(Some(shared));
			let class: Vec<u16> = "omp desktop user input\0".encode_utf16().collect();
			// SAFETY: the class name outlives both calls; a message-only window
			// needs no instance handle. A class an earlier, failed start
			// registered is reused.
			let window = unsafe {
				RegisterClassW(&WNDCLASSW {
					lpfnWndProc: Some(receive),
					lpszClassName: class.as_ptr(),
					..Default::default()
				});
				CreateWindowExW(
					0,
					class.as_ptr(),
					std::ptr::null(),
					0,
					0,
					0,
					0,
					0,
					HWND_MESSAGE,
					std::ptr::null_mut(),
					std::ptr::null_mut(),
					std::ptr::null(),
				)
			};
			let registered = !window.is_null() && {
				let devices = devices(RIDEV_INPUTSINK, window);
				// SAFETY: `devices` outlives the call.
				let ok = unsafe {
					RegisterRawInputDevices(devices.as_ptr(), 2, size_of::<RAWINPUTDEVICE>() as u32)
				};
				ok != 0
			};
			if !registered {
				if !window.is_null() {
					// SAFETY: this thread created the window.
					unsafe { DestroyWindow(window) };
				}
				let _ = ready.send(false);
				return;
			}
			let _ = ready.send(true);
			// SAFETY: MSG is plain storage owned by this thread.
			let mut message: MSG = unsafe { std::mem::zeroed() };
			// SAFETY: writable storage; the loop runs for the process's life.
			while unsafe { GetMessageW(&raw mut message, std::ptr::null_mut(), 0, 0) } > 0 {
				// SAFETY: a message this thread's queue returned.
				unsafe { DispatchMessageW(&raw const message) };
			}
		})
		.map_err(|error| {
			DesktopError::input_failed(format!("cannot start watching the user's input: {error}"))
		})?;
	if receive_ready.recv().unwrap_or(false) {
		Ok(presses)
	} else {
		let _ = thread.join();
		Err(unwatched())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn presses(last: Option<Instant>) -> Presses {
		Presses { count: AtomicU64::new(0), last: Mutex::new(last) }
	}

	#[test]
	fn a_takeover_waits_for_the_user_to_pause_and_refuses_once_they_never_do() {
		let start = Instant::now();
		let clock = std::cell::Cell::new(start);
		let typing = presses(start.checked_sub(Duration::from_secs(1)));
		let error = admit_with(
			&typing,
			start + Duration::from_secs(2),
			|| clock.get(),
			|| false,
			|wait| {
				// The user keeps typing through every wait.
				clock.set(clock.get() + wait);
				typing.record(clock.get());
				Ok(())
			},
		)
		.unwrap_err();
		assert_eq!(error.code, crate::desktop::error::ErrorCode::UserIntervened);
		assert!(error.message.contains("nothing was sent"), "{}", error.message);

		let paused = presses(start.checked_sub(Duration::from_secs(1)));
		let waited = std::cell::Cell::new(Duration::ZERO);
		admit_with(
			&paused,
			start + Duration::from_secs(30),
			|| start + waited.get(),
			|| false,
			|wait| {
				waited.set(waited.get() + wait);
				Ok(())
			},
		)
		.unwrap();
		assert_eq!(waited.get(), Duration::from_secs(4));

		let mut waits = 0;
		admit_with(
			&presses(None),
			start,
			|| start,
			|| false,
			|_| {
				waits += 1;
				Ok(())
			},
		)
		.unwrap();
		assert_eq!(waits, 0, "an idle user adds no wait");
	}

	#[test]
	fn a_press_after_admission_stops_the_takeover_and_injected_input_is_not_a_press() {
		let presses = Arc::new(presses(None));
		ADMITTED.set(Some((Arc::clone(&presses), 0)));
		let takeover = start().unwrap();
		check().unwrap();
		let mut input = RAWINPUT::default();
		input.header.dwType = RIM_TYPEKEYBOARD;
		assert!(!is_user_press(&input), "SendInput has no device");
		input.header.hDevice = std::ptr::without_provenance_mut(1);
		assert!(is_user_press(&input));
		input.data.keyboard.Flags = RI_KEY_BREAK as u16;
		assert!(!is_user_press(&input), "a key-up is no press");
		input.header.dwType = RIM_TYPEMOUSE;
		input.data.mouse.Anonymous.Anonymous.usButtonFlags = 0;
		assert!(!is_user_press(&input), "a move is no press");
		input.data.mouse.Anonymous.Anonymous.usButtonFlags = RI_MOUSE_WHEEL as u16;
		assert!(is_user_press(&input));
		presses.record(Instant::now());
		let error = check().unwrap_err();
		assert_eq!(error.code, crate::desktop::error::ErrorCode::UserIntervened);
		drop(takeover);
		check().unwrap();

		// A press between the worker's admission and the takeover's start.
		ADMITTED.set(Some((Arc::clone(&presses), 0)));
		let error = start().err().expect("the user pressed after admission");
		assert_eq!(error.code, crate::desktop::error::ErrorCode::UserIntervened);
		assert!(error.message.contains("nothing was sent"), "{}", error.message);
	}

	#[test]
	#[ignore = "sends input to the desktop: run with --ignored in a signed-in desktop session"]
	fn the_listener_does_not_count_input_this_process_sends() {
		use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
			INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
			MOUSEEVENTF_WHEEL, MOUSEINPUT, SendInput,
		};
		let activity = UserActivity::start().unwrap();
		let key = |flags| INPUT {
			r#type:    INPUT_KEYBOARD,
			Anonymous: INPUT_0 {
				// 0xE8 is unassigned: it types nothing.
				ki: KEYBDINPUT {
					wVk:         0xe8,
					wScan:       0,
					dwFlags:     flags,
					time:        0,
					dwExtraInfo: 0,
				},
			},
		};
		let wheel = INPUT {
			r#type:    INPUT_MOUSE,
			Anonymous: INPUT_0 {
				mi: MOUSEINPUT {
					dx:          0,
					dy:          0,
					mouseData:   0,
					dwFlags:     MOUSEEVENTF_WHEEL,
					time:        0,
					dwExtraInfo: 0,
				},
			},
		};
		let inputs = [key(0), key(KEYEVENTF_KEYUP), wheel];
		let before = activity.presses.count.load(Ordering::Acquire);
		// SAFETY: `inputs` is an initialized INPUT slice copied synchronously.
		let sent =
			unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), size_of::<INPUT>() as i32) };
		assert_eq!(sent as usize, inputs.len());
		std::thread::sleep(Duration::from_millis(300));
		assert_eq!(activity.presses.count.load(Ordering::Acquire), before);
	}
}
