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
//! for it. Registration, the message-only window and its thread exist only
//! from a takeover call's admission until that call returns. Overlapping
//! admissions share them; the last watch removes them synchronously.
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
	System::{
		SystemInformation::{GetTickCount, GetTickCount64},
		Threading::GetCurrentThreadId,
	},
	UI::{
		Input::{
			GetRawInputData, HRAWINPUT,
			KeyboardAndMouse::{
				GetAsyncKeyState, GetLastInputInfo, LASTINPUTINFO, VK_CONTROL, VK_LBUTTON, VK_LWIN,
				VK_MBUTTON, VK_MENU, VK_RBUTTON, VK_RWIN, VK_SHIFT, VK_XBUTTON1, VK_XBUTTON2,
			},
			RAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER, RID_INPUT, RIDEV_INPUTSINK, RIM_TYPEKEYBOARD,
			RIM_TYPEMOUSE, RIDEV_REMOVE, RegisterRawInputDevices,
		},
		WindowsAndMessaging::{
			CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
			HWND_MESSAGE, MSG, PostThreadMessageW, RI_KEY_BREAK, RI_MOUSE_BUTTON_4_DOWN,
			RI_MOUSE_BUTTON_5_DOWN, RI_MOUSE_HWHEEL, RI_MOUSE_LEFT_BUTTON_DOWN,
			RI_MOUSE_MIDDLE_BUTTON_DOWN, RI_MOUSE_RIGHT_BUTTON_DOWN, RI_MOUSE_WHEEL, RegisterClassW,
			UnregisterClassW, WM_INPUT, WM_QUIT, WNDCLASSW,
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
	last:  Mutex<Option<Duration>>,
}

impl Presses {
	fn record(&self, at: Duration) {
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

/// Serializes both transitions: a new watch cannot register until the old
/// listener has removed its devices and its thread has ended.
struct Watches<R> {
	state: Mutex<Option<(usize, Arc<Presses>, R)>>,
}

impl<R> Watches<R> {
	const fn new() -> Self {
		Self { state: Mutex::new(None) }
	}

	fn watch(
		&self,
		register: impl FnOnce() -> CoreResult<(Arc<Presses>, R)>,
	) -> CoreResult<Watch<'_, R>> {
		let mut state = self.state.lock();
		if state.is_none() {
			let (presses, registration) = register()?;
			*state = Some((0, presses, registration));
		}
		let (count, presses, _) = state.as_mut().expect("registered above");
		*count += 1;
		Ok(Watch { watches: self, presses: Arc::clone(presses) })
	}
}

struct Watch<'a, R> {
	watches: &'a Watches<R>,
	presses: Arc<Presses>,
}

impl<R> Drop for Watch<'_, R> {
	fn drop(&mut self) {
		let mut state = self.watches.state.lock();
		let (count, _, _) = state.as_mut().expect("a watch owns a registration");
		*count -= 1;
		if *count == 0 {
			// Drop the registration under the lock: remove and join before
			// another session can register the same process-wide devices.
			*state = None;
		}
	}
}

static WATCHES: Watches<Listener> = Watches::new();

/// Owned by the native call scope, including admission before a lease exists.
pub(crate) struct UserActivity(Watch<'static, Listener>);

impl UserActivity {
	pub(crate) fn start() -> CoreResult<Self> {
		WATCHES.watch(listen).map(Self)
	}
}

impl Drop for UserActivity {
	fn drop(&mut self) {
		ADMITTED.set(None);
	}
}

/// The worker's call-scope watch already owns the registration.
pub(super) fn admit() -> CoreResult<()> {
	ADMITTED.set(None);
	let presses = WATCHES
		.state
		.lock()
		.as_ref()
		.map(|(_, presses, _)| Arc::clone(presses))
		.ok_or_else(unwatched)?;
	let deadline = control::current_token().and_then(|token| token.deadline());
	let limit = deadline.map_or_else(
		|| now() + QUIET,
		|deadline| {
			now() + deadline.saturating_duration_since(Instant::now())
				.saturating_sub(control::DEADLINE_MARGIN)
		},
	);
	let count = admit_with(&presses, limit, now, input_held, control::wait)?;
	ADMITTED.set(Some((presses, count)));
	Ok(())
}

/// With the input lease held: whether the user has pressed nothing since
/// [`admit`] and holds no key or button.
pub(super) fn admitted() -> bool {
	ADMITTED.with_borrow(|admitted| {
		admitted
			.as_ref()
			.is_some_and(|(presses, baseline)| presses.count.load(Ordering::Acquire) == *baseline)
	}) && !input_held()
}

/// Keeps the current thread's takeover watched until dropped.
#[cfg_attr(test, derive(Default))]
pub(super) struct Takeover<R = Option<UserActivity>> {
	_watch: R,
}

impl<R> Drop for Takeover<R> {
	fn drop(&mut self) {
		ACTIVE.set(None);
		ADMITTED.set(None);
	}
}

/// As a takeover starts, before it brings its target forward: fails once the
/// user has pressed a key or button since the worker admitted it, or holds
/// one. A takeover the worker did not admit is admitted here without waiting:
/// the input lease is held, so a user still active refuses it at once.
pub(super) fn start() -> CoreResult<Takeover> {
	let watch = UserActivity::start()?;
	let presses = Arc::clone(&watch.0.presses);
	start_with(Some(watch), presses, now, input_held, control::wait)
}

fn start_with<R>(
	watch: R,
	presses: Arc<Presses>,
	now: impl Fn() -> Duration,
	held: impl Fn() -> bool,
	wait: impl FnMut(Duration) -> CoreResult<()>,
) -> CoreResult<Takeover<R>> {
	ACTIVE.set(None);
	let baseline = if let Some((presses, baseline)) = ADMITTED.take() {
		if presses.count.load(Ordering::Acquire) != baseline || held() {
			return Err(DesktopError::user_intervened(
				"the user pressed or is holding a key or button as the takeover was starting, so none \
				 started; nothing was sent; try again once they pause",
			));
		}
		(presses, baseline)
	} else {
		let baseline = admit_with(&presses, now(), now, held, wait)?;
		(presses, baseline)
	};
	ACTIVE.set(Some(baseline));
	Ok(Takeover { _watch: watch })
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
	limit: Duration,
	now: impl Fn() -> Duration,
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
		let idle = now.saturating_sub(last);
		if idle >= QUIET {
			return Ok(count);
		}
		if now >= limit {
			return Err(control::still_active_refusal(idle));
		}
		let quiet = (last + QUIET).min(limit).saturating_sub(now);
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
/// Other processes' injected input can only lengthen admission's wait.
fn last_input_before(started: Duration) -> Option<Duration> {
	let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
	// SAFETY: `info` is writable and its size is set.
	if unsafe { GetLastInputInfo(&raw mut info) } == 0 {
		return None;
	}
	if !user_tick(info.dwTime, OWN_SEND.load(Ordering::Acquire)) {
		return None;
	}
	// SAFETY: GetTickCount has no preconditions; both ticks wrap together.
	let idle = unsafe { GetTickCount() }.wrapping_sub(info.dwTime);
	started.checked_sub(Duration::from_millis(idle.into()))
}

fn now() -> Duration {
	// SAFETY: GetTickCount64 has no preconditions and is monotonic.
	Duration::from_millis(unsafe { GetTickCount64() })
}

// The high bit distinguishes no SendInput yet from a send at tick zero.
static OWN_SEND: AtomicU64 = AtomicU64::new(0);

pub(super) fn sent() {
	// SAFETY: GetTickCount has no preconditions.
	let tick = unsafe { GetTickCount() };
	OWN_SEND.store((1_u64 << 32) | u64::from(tick), Ordering::Release);
}

fn user_tick(last: u32, own: u64) -> bool {
	own == 0 || (last.wrapping_sub(own as u32) as i32) > 0
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
					presses.record(now());
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

struct Listener {
	thread: Option<thread::JoinHandle<()>>,
	id: u32,
}

impl Drop for Listener {
	fn drop(&mut self) {
		// SAFETY: the live listener published its thread id after creating
		// its window/queue. WM_QUIT ends its loop; join acknowledges removal.
		unsafe { PostThreadMessageW(self.id, WM_QUIT, 0, 0) };
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
	}
}

fn listen() -> CoreResult<(Arc<Presses>, Listener)> {
	let presses = Arc::new(Presses { count: AtomicU64::new(0), last: Mutex::new(None) });
	let (ready, receive_ready) = flume::bounded(1);
	let shared = Arc::clone(&presses);
	let thread = thread::Builder::new()
		.name("desktop-user-input".into())
		.spawn(move || {
			LISTENING.set(Some(shared));
			let class: Vec<u16> = "omp desktop user input\0".encode_utf16().collect();
			// SAFETY: the class name outlives both calls; a message-only window
			// needs no instance handle. Watches serialize class ownership too.
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
				// SAFETY: no live window uses this class, even when creation failed.
				unsafe { UnregisterClassW(class.as_ptr(), std::ptr::null_mut()) };
				let _ = ready.send(None);
				return;
			}
			// Registration precedes the history sample, so input during thread
			// startup is covered by history or by the queue, never neither.
			LISTENING.with_borrow(|presses| {
				if let Some(presses) = presses {
					*presses.last.lock() = last_input_before(now());
				}
			});
			// SAFETY: no preconditions; the window above created this queue.
			let _ = ready.send(Some(unsafe { GetCurrentThreadId() }));
			// SAFETY: MSG is plain storage owned by this thread.
			let mut message: MSG = unsafe { std::mem::zeroed() };
			// SAFETY: writable storage; WM_QUIT ends this call's listener.
			while unsafe { GetMessageW(&raw mut message, std::ptr::null_mut(), 0, 0) } > 0 {
				// SAFETY: a message this thread's queue returned.
				unsafe { DispatchMessageW(&raw const message) };
			}
			let devices = devices(RIDEV_REMOVE, std::ptr::null_mut());
			// SAFETY: removal requires a null target. Both removal and window
			// destruction run on the thread which registered/created them.
			unsafe {
				RegisterRawInputDevices(devices.as_ptr(), 2, size_of::<RAWINPUTDEVICE>() as u32);
				DestroyWindow(window);
				UnregisterClassW(class.as_ptr(), std::ptr::null_mut());
			}
			LISTENING.set(None);
		})
		.map_err(|error| {
			DesktopError::input_failed(format!("cannot start watching the user's input: {error}"))
		})?;
	if let Ok(Some(id)) = receive_ready.recv() {
		Ok((presses, Listener { thread: Some(thread), id }))
	} else {
		let _ = thread.join();
		Err(unwatched())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn presses(last: Option<Duration>) -> Presses {
		Presses { count: AtomicU64::new(0), last: Mutex::new(last) }
	}

	#[test]
	fn a_takeover_waits_for_the_user_to_pause_and_refuses_once_they_never_do() {
		let start = Duration::from_secs(100);
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
		let takeover =
			start_with((), Arc::clone(&presses), || Duration::ZERO, || false, |_| Ok(())).unwrap();
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
		presses.record(Duration::ZERO);
		let error = check().unwrap_err();
		assert_eq!(error.code, crate::desktop::error::ErrorCode::UserIntervened);
		drop(takeover);
		check().unwrap();

		// A press between the worker's admission and the takeover's start.
		ADMITTED.set(Some((Arc::clone(&presses), 0)));
		let error = start_with((), Arc::clone(&presses), || Duration::ZERO, || false, |_| Ok(()))
			.err()
			.expect("the user pressed after admission");
		assert_eq!(error.code, crate::desktop::error::ErrorCode::UserIntervened);
		assert!(error.message.contains("nothing was sent"), "{}", error.message);
	}

	struct Registration<'a>(&'a std::cell::Cell<usize>);

	impl Drop for Registration<'_> {
		fn drop(&mut self) {
			self.0.set(self.0.get() + 1);
		}
	}

	#[test]
	fn call_watches_balance_on_success_refusal_cancel_early_error_and_panic() {
		let registered = std::cell::Cell::new(0);
		let removed = std::cell::Cell::new(0);
		let watches = Watches::new();
		let register = || {
			registered.set(registered.get() + 1);
			Ok((Arc::new(presses(None)), Registration(&removed)))
		};
		let clock = || Duration::from_secs(100);
		{
			let call = watches.watch(register).unwrap();
			let count = admit_with(&call.presses, clock(), clock, || false, |_| Ok(())).unwrap();
			ADMITTED.set(Some((Arc::clone(&call.presses), count)));
			let input = watches.watch(register).unwrap();
			let presses = Arc::clone(&input.presses);
			drop(start_with(input, presses, clock, || false, |_| Ok(())).unwrap());
			assert_eq!(removed.get(), 0);
		}
		assert_eq!((registered.get(), removed.get()), (1, 1));

		let refused = || -> CoreResult<()> {
			let call = watches.watch(register)?;
			admit_with(&call.presses, clock(), clock, || true, |_| Ok(()))?;
			Ok(())
		};
		assert_eq!(refused().unwrap_err().code, crate::desktop::error::ErrorCode::UserIntervened);
		assert_eq!((registered.get(), removed.get()), (2, 2));

		let cancelled = || -> CoreResult<()> {
			let call = watches.watch(register)?;
			admit_with(
				&call.presses,
				clock() + QUIET,
				clock,
				|| true,
				|_| Err(DesktopError::cancelled("cancelled wait")),
			)?;
			Ok(())
		};
		assert_eq!(cancelled().unwrap_err().code, crate::desktop::error::ErrorCode::Cancelled);
		assert_eq!((registered.get(), removed.get()), (3, 3));

		// Admission succeeds, but the call ends before starting input.
		{
			let call = watches.watch(register).unwrap();
			admit_with(&call.presses, clock(), clock, || false, |_| Ok(())).unwrap();
		}
		assert_eq!((registered.get(), removed.get()), (4, 4));

		// Direct input, without worker admission, owns its own watch.
		{
			let input = watches.watch(register).unwrap();
			let presses = Arc::clone(&input.presses);
			let _takeover = start_with(input, presses, clock, || false, |_| Ok(())).unwrap();
		}
		assert_eq!((registered.get(), removed.get()), (5, 5));

		let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
			let _call = watches.watch(register).unwrap();
			panic!("call panicked before input");
		}));
		assert!(panic.is_err());
		assert_eq!((registered.get(), removed.get()), (6, 6));
	}

	#[test]
	fn overlapping_watches_share_one_registration_until_the_last_drop() {
		let removed = std::cell::Cell::new(0);
		let watches = Watches::new();
		let first = watches.watch(|| Ok((Arc::new(presses(None)), Registration(&removed)))).unwrap();
		let second = watches.watch(|| panic!("must reuse the existing registration")).unwrap();
		drop(first);
		assert_eq!(removed.get(), 0);
		drop(second);
		assert_eq!(removed.get(), 1);
	}

	#[test]
	fn history_at_or_before_our_send_is_not_the_users_input() {
		let own = (1_u64 << 32) | 100;
		assert!(!user_tick(99, own));
		assert!(!user_tick(100, own));
		assert!(user_tick(101, own));
		assert!(user_tick(0, 0), "no own input yet");
		assert!(user_tick(1, (1_u64 << 32) | u64::from(u32::MAX)));
	}
}
