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
//! admissions share them; the last watch removes them synchronously, and the
//! time of the last press it saw outlives it, so a takeover that stopped at a
//! press still holds the next one back. Only how many presses there were and
//! when the last one was are kept, never which key or button, and pointer
//! moves are not counted.
//!
//! Windows keeps one keyboard and one mouse registration per process. When the
//! process already has one (an embedding host's), or its registrations cannot
//! be listed, it is left alone: the watch polls the session's last input time
//! instead, where a pointer move counts as the user's too, and says so. Should
//! another receiver of the process take the keyboard or mouse registration
//! while OMP listens, the user's presses stop reaching OMP, so the takeover
//! fails rather than carrying on unwatched.
use std::{
	cell::RefCell,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering},
	},
	thread,
	time::Duration,
};

use parking_lot::{Condvar, Mutex, MutexGuard};
use windows_sys::Win32::{
	Foundation::{CloseHandle, HANDLE, HWND, LPARAM, LRESULT, WAIT_OBJECT_0, WPARAM},
	System::{
		SystemInformation::GetTickCount64,
		Threading::{CreateEventW, INFINITE, SetEvent, WaitForSingleObject},
	},
	UI::{
		Input::{
			GetRawInputData, GetRegisteredRawInputDevices, HRAWINPUT,
			KeyboardAndMouse::{
				GetAsyncKeyState, GetLastInputInfo, LASTINPUTINFO, VK_CONTROL, VK_LBUTTON, VK_LWIN,
				VK_MBUTTON, VK_MENU, VK_RBUTTON, VK_RWIN, VK_SHIFT, VK_XBUTTON1, VK_XBUTTON2,
			},
			RAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER, RID_INPUT, RIDEV_INPUTSINK, RIDEV_REMOVE,
			RIM_TYPEKEYBOARD, RIM_TYPEMOUSE, RegisterRawInputDevices,
		},
		WindowsAndMessaging::{
			CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, HWND_MESSAGE, MSG,
			MsgWaitForMultipleObjects, PM_REMOVE, PeekMessageW, QS_ALLINPUT, RI_KEY_BREAK,
			RI_MOUSE_BUTTON_4_DOWN, RI_MOUSE_BUTTON_5_DOWN, RI_MOUSE_HWHEEL,
			RI_MOUSE_LEFT_BUTTON_DOWN, RI_MOUSE_MIDDLE_BUTTON_DOWN, RI_MOUSE_RIGHT_BUTTON_DOWN,
			RI_MOUSE_WHEEL, RegisterClassW, UnregisterClassW, WM_INPUT, WNDCLASSW,
		},
	},
};

use crate::desktop::{
	control::{self, USER_QUIET as QUIET},
	error::{CoreResult, DesktopError, ErrorCode},
};

pub(super) const READ_AGAIN: &str =
	"read the window again (win.ax(), win.observe() or win.screenshot()) before acting on it";
/// Appended to what a watch that polls the session's last input time reports.
const POLLED: &str = "omp watched Windows' last-input timestamp because this process already had \
                      a Raw Input receiver or its registrations could not be listed; changes are \
                      unattributed and can include pointer movement or injected input; OMP's \
                      own-send windows are excluded and can hide coincident user input";
/// What stopped a takeover that saw the user's own press.
const PRESSED: &str = "the user pressed a key or clicked during this takeover";
/// What stopped a takeover that polled the session's last input time.
const INPUT_CHANGED: &str = "the session's last input time changed during this takeover";
/// Why a listening watch went blind: its receiver no longer gets the presses.
const LOST: &str = "another Raw Input receiver in this process took over its keyboard or mouse \
                    registration, or the registrations could not be listed";
/// Why a polling watch went blind.
const UNREADABLE: &str = "the session's last input time could not be read";
/// Why no watch could start.
const UNREGISTERED: &str = "Raw Input registration failed";
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
	count:   AtomicU64,
	last:    Mutex<Option<Duration>>,
	watched: Watched,
}

/// How a watch learns of the user's presses.
enum Watched {
	/// Raw Input delivers them to the listener's message-only `window` (an
	/// `HWND`, set once registered) while `owns` finds the process's keyboard
	/// and mouse registrations both targeting it. Once they do not, the watch
	/// is `lost` for good: whatever took them gets the presses from then on.
	Listening { window: AtomicIsize, owns: fn(HWND) -> bool, lost: AtomicBool },
	/// The session's last input tick, already looked at.
	Polling(Mutex<u32>),
}

impl Watched {
	const fn listening(owns: fn(HWND) -> bool) -> Self {
		Self::Listening { window: AtomicIsize::new(0), owns, lost: AtomicBool::new(false) }
	}
}

impl Presses {
	const fn new(last: Option<Duration>, watched: Watched) -> Self {
		Self { count: AtomicU64::new(0), last: Mutex::new(last), watched }
	}

	/// A polling watch from `seen`, the last press an earlier registration
	/// saw, and `sample`: its tick is looked at already, and dates a newer
	/// last press unless it came from OMP's own send.
	fn polling(seen: Option<Duration>, sample: Sample) -> Self {
		Self::new(seen.max(sample.press()), Watched::Polling(Mutex::new(sample.tick)))
	}

	const fn polled(&self) -> bool {
		matches!(self.watched, Watched::Polling(_))
	}

	fn record(&self, at: Duration) {
		let mut last = self.last.lock();
		*last = (*last).max(Some(at));
		self.count.fetch_add(1, Ordering::AcqRel);
	}

	/// Brings the count up to date: a polling watch counts the session's
	/// newest input as a press unless it came from OMP's own send. Fails,
	/// saying why, once the watch can no longer see the user's input.
	fn refresh(&self) -> Result<(), &'static str> {
		match &self.watched {
			Watched::Listening { window, owns, lost } => {
				if lost.load(Ordering::Acquire) || !owns(window.load(Ordering::Acquire) as HWND) {
					lost.store(true, Ordering::Release);
					return Err(LOST);
				}
				Ok(())
			},
			Watched::Polling(looked) => {
				let mut looked = looked.lock();
				let sample = Sample::read().ok_or(UNREADABLE)?;
				self.poll(&mut looked, sample);
				Ok(())
			},
		}
	}

	/// Counts `sample` as a press unless its tick was already `looked` at or
	/// came from OMP's own send.
	fn poll(&self, looked: &mut u32, sample: Sample) {
		if sample.tick == *looked {
			return;
		}
		*looked = sample.tick;
		if let Some(at) = sample.press() {
			self.record(at);
		}
	}

	/// `error` from this watch, naming how it watched when it polled.
	fn noted(&self, mut error: DesktopError) -> DesktopError {
		if self.polled() {
			error.message.push_str("; ");
			error.message.push_str(POLLED);
		}
		error
	}

	/// What a change of the count during a takeover means.
	const fn interruption(&self) -> &'static str {
		if self.polled() {
			INPUT_CHANGED
		} else {
			PRESSED
		}
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

/// Reports teardown failure before the last watch permits another admission.
trait Unregister {
	fn unregister(&mut self) -> CoreResult<()>;
}

/// A transition excludes new registrations without holding the state lock
/// while the listener starts or joins. Waiters release it through the condvar.
/// `Idle` keeps the last press the previous registration knew of: OMP's own
/// input since then may hide it from the session's history.
enum Registration<R> {
	Idle(Option<Duration>),
	Changing,
	Live(usize, Arc<Presses>, R),
	Failed(DesktopError),
}

struct Watches<R: Unregister> {
	state:   Mutex<Registration<R>>,
	changed: Condvar,
}

impl<R: Unregister> Watches<R> {
	const fn new() -> Self {
		Self { state: Mutex::new(Registration::Idle(None)), changed: Condvar::new() }
	}

	/// `register` starts a registration from the last press already known.
	fn watch(
		&self,
		register: impl FnOnce(Option<Duration>) -> CoreResult<(Arc<Presses>, R)>,
	) -> CoreResult<Watch<'_, R>> {
		let mut state = self.state.lock();
		let seen = loop {
			match &mut *state {
				Registration::Live(count, presses, _) => {
					*count += 1;
					return Ok(Watch { watches: self, presses: Arc::clone(presses) });
				},
				Registration::Changing => self.changed.wait(&mut state),
				Registration::Failed(error) => return Err(error.clone()),
				Registration::Idle(seen) => break *seen,
			}
		};
		*state = Registration::Changing;
		drop(state);
		let registered = register(seen);
		let mut state = self.state.lock();
		let result = match registered {
			Ok((presses, registration)) => {
				let watch = Watch { watches: self, presses: Arc::clone(&presses) };
				*state = Registration::Live(1, presses, registration);
				Ok(watch)
			},
			Err(error) => {
				*state = Registration::Idle(seen);
				Err(error)
			},
		};
		self.changed.notify_all();
		result
	}

	fn presses(&self) -> Option<Arc<Presses>> {
		match &*self.state.lock() {
			Registration::Live(_, presses, _) => Some(Arc::clone(presses)),
			Registration::Idle(_) | Registration::Changing | Registration::Failed(_) => None,
		}
	}
}

struct Watch<'a, R: Unregister> {
	watches: &'a Watches<R>,
	presses: Arc<Presses>,
}

impl<R: Unregister> Drop for Watch<'_, R> {
	fn drop(&mut self) {
		let mut state = self.watches.state.lock();
		let Registration::Live(count, ..) = &mut *state else {
			unreachable!("a watch owns a live registration");
		};
		*count -= 1;
		if *count != 0 {
			return;
		}
		let registration = std::mem::replace(&mut *state, Registration::Changing);
		drop(state);
		// Join acknowledges removal, destruction and any listener panic.
		// A failed teardown poisons admission rather than pretending the
		// process-wide registration is clean; restart the process to recover.
		let result = match registration {
			Registration::Live(_, _, mut listener) => listener.unregister(),
			_ => unreachable!("the last watch removed a live registration"),
		};
		*self.watches.state.lock() = match result {
			Ok(()) => Registration::Idle(*self.presses.last.lock()),
			Err(error) => Registration::Failed(error),
		};
		self.watches.changed.notify_all();
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
	let presses = WATCHES.presses().ok_or_else(|| unwatched(UNREGISTERED))?;
	let limit = now() + control::time_left().unwrap_or(QUIET);
	let count = admit_with(&presses, limit, now, input_held, control::wait)?;
	ADMITTED.set(Some((presses, count)));
	Ok(())
}

/// With the input lease held: whether the user has pressed nothing since
/// [`admit`] and holds no key or button. A watch that can no longer see
/// presses is not admitted; the next [`admit`] says why.
pub(super) fn admitted() -> bool {
	let Some(current) = WATCHES.presses() else {
		return false;
	};
	if current.refresh().is_err() {
		return false;
	}
	ADMITTED.with_borrow(|admitted| {
		admitted.as_ref().is_some_and(|(presses, baseline)| {
			Arc::ptr_eq(presses, &current) && presses.count.load(Ordering::Acquire) == *baseline
		})
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
	let admitted = ADMITTED.take();
	presses
		.refresh()
		.map_err(|reason| presses.noted(unwatched(reason)))?;
	let baseline = if let Some((admitted, baseline)) = admitted {
		// The Arc's identity is the registration generation: an old baseline
		// retains its allocation, so a later registration cannot reuse it.
		if !Arc::ptr_eq(&presses, &admitted)
			|| admitted.count.load(Ordering::Acquire) != baseline
			|| held()
		{
			let what = if presses.polled() {
				"the session's last input time changed or the user is holding a key or button"
			} else {
				"the user pressed or is holding a key or button"
			};
			return Err(presses.noted(DesktopError::user_intervened(format!(
				"{what} as the takeover was starting, so none started; nothing was sent; try again \
				 once they pause",
			))));
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
/// thread's takeover started ([`start`]), with `UserIntervened`, or once its
/// watch can no longer see their input, with `InputFailed`; outside a
/// takeover there is nothing to compare.
pub(super) fn check() -> CoreResult<()> {
	ACTIVE.with_borrow(|active| {
		let Some((presses, baseline)) = active else {
			return Ok(());
		};
		let refreshed = presses.refresh();
		if presses.count.load(Ordering::Acquire) != *baseline {
			return Err(presses.noted(DesktopError::user_intervened(format!(
				"{}; input sent before that may already have landed, and nothing more was sent; \
				 {READ_AGAIN}",
				presses.interruption(),
			))));
		}
		refreshed.map_err(|reason| {
			presses.noted(DesktopError::input_failed(format!(
				"omp stopped seeing the user's keys and clicks during this takeover ({reason}); input \
				 sent before that may already have landed, and nothing more was sent; {READ_AGAIN}"
			)))
		})
	})
}

/// A takeover's `result`, unless [`check`] fails: the user has pressed
/// something since it started, or its watch went blind. That failure is the
/// outcome, still saying whatever else failed (a release Windows refused, a
/// hand-back it refused).
pub(super) fn outcome(result: CoreResult<()>) -> CoreResult<()> {
	match (check(), result) {
		(Ok(()), result) => result,
		(Err(_), Err(error)) if error.code == ErrorCode::UserIntervened => Err(error),
		(Err(mut stopped), Err(error)) => {
			stopped.message.push_str("; also failed: ");
			stopped.message.push_str(&error.message);
			Err(stopped)
		},
		(Err(stopped), Ok(())) => Err(stopped),
	}
}

/// What stopped the current thread's takeover when its count changed: the
/// user's own press, or, for a watch that polls, a change of the session's
/// last input time, which need not have been a press.
pub(super) fn interruption() -> &'static str {
	ACTIVE.with_borrow(|active| {
		active
			.as_ref()
			.map_or(PRESSED, |(presses, _)| presses.interruption())
	})
}

/// Whether the current takeover polls the session's last input time, the
/// process already having its own Raw Input receiver or its receivers not
/// listable.
pub(super) fn polled() -> bool {
	ACTIVE.with_borrow(|active| matches!(active, Some((presses, _)) if presses.polled()))
}

/// Runs `run` in a listening takeover whose user has already pressed
/// something, as [`check`] and [`outcome`] then report; the thread's
/// takeover state is restored afterwards, even on unwinding.
#[cfg(test)]
pub(super) fn with_press_for_test<R>(run: impl FnOnce() -> R) -> R {
	struct Restore(Option<Baseline>);
	impl Drop for Restore {
		fn drop(&mut self) {
			ACTIVE.set(self.0.take());
		}
	}
	let presses = Arc::new(Presses::new(None, Watched::listening(|_| true)));
	presses.record(Duration::ZERO);
	let _restore = Restore(ACTIVE.replace(Some((presses, 0))));
	run()
}

/// Admission's failure when the user's input cannot be watched, for `reason`.
fn unwatched(reason: &str) -> DesktopError {
	DesktopError::input_failed(format!(
		"cannot watch the user's keys and clicks ({reason}), so no takeover started; nothing was \
		 sent"
	))
}

fn admit_with(
	presses: &Presses,
	limit: Duration,
	now: impl Fn() -> Duration,
	held: impl Fn() -> bool,
	mut wait: impl FnMut(Duration) -> CoreResult<()>,
) -> CoreResult<u64> {
	loop {
		presses
			.refresh()
			.map_err(|reason| presses.noted(unwatched(reason)))?;
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
			return Err(presses.noted(if presses.polled() {
				DesktopError::user_intervened(format!(
					"the session's last input time changed {:.1} s ago or the user is holding a key or \
					 button, so no takeover started; nothing was sent; try again once they pause",
					idle.as_secs_f64(),
				))
			} else {
				control::still_active_refusal(idle)
			}));
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

/// One reading of the session's last input `tick` and of `GetTickCount64`
/// (`now`, in ms), taken with OMP's send record (`own`) held, so no send of
/// OMP's is seen before it is recorded. The tick is in `GetTickCount` time,
/// the low 32 bits of `GetTickCount64`, so this one reading dates the input
/// exactly: no delay between separate clock reads moves it.
#[derive(Clone, Copy)]
struct Sample {
	tick: u32,
	now:  u64,
	own:  Option<OwnSend>,
}

impl Sample {
	fn read() -> Option<Self> {
		let own = OWN_SEND.lock();
		let tick = last_input_tick()?;
		// SAFETY: GetTickCount64 has no preconditions; read after the tick, so
		// never before it.
		let now = unsafe { GetTickCount64() };
		Some(Self { tick, now, own: *own })
	}

	/// When the input was, on `GetTickCount64`'s clock, unless it came from
	/// OMP's own send. Injected timestamps can move it backward.
	fn press(self) -> Option<Duration> {
		let now = Duration::from_millis(self.now);
		if !user_tick(self.tick, self.own, now) {
			return None;
		}
		now.checked_sub(Duration::from_millis((self.now as u32).wrapping_sub(self.tick).into()))
	}
}

/// The session's last input tick, from any source.
fn last_input_tick() -> Option<u32> {
	let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
	// SAFETY: `info` is writable and its size is set.
	(unsafe { GetLastInputInfo(&raw mut info) } != 0).then_some(info.dwTime)
}

fn now() -> Duration {
	// SAFETY: GetTickCount64 has no preconditions and is monotonic.
	Duration::from_millis(unsafe { GetTickCount64() })
}

#[derive(Clone, Copy)]
struct OwnSend {
	before: u32,
	after:  u32,
	at:     Duration,
}

static OWN_SEND: Mutex<Option<OwnSend>> = Mutex::new(None);
const SEND_HISTORY: Duration = Duration::from_secs(60);
const MAX_SEND_WINDOW_MS: u32 = 50;

/// OMP's input on its way out. It holds the record of OMP's sends until
/// [`Sending::sent`], so a poll never reads the session's last input between
/// a send and its record.
pub(super) struct Sending {
	own:    MutexGuard<'static, Option<OwnSend>>,
	before: u32,
}

pub(super) fn sending() -> Sending {
	let own = OWN_SEND.lock();
	// SAFETY: GetTickCount64 has no preconditions; its low 32 bits are the
	// session's input ticks.
	Sending { own, before: unsafe { GetTickCount64() } as u32 }
}

impl Sending {
	/// Ends the send, recording it when Windows `inserted` any of it.
	pub(super) fn sent(mut self, inserted: bool) {
		if inserted {
			// SAFETY: as above.
			let after = unsafe { GetTickCount64() };
			*self.own = Some(OwnSend {
				before: self.before,
				after:  after as u32,
				at:     Duration::from_millis(after),
			});
		}
	}
}

fn user_tick(last: u32, own: Option<OwnSend>, at: Duration) -> bool {
	let Some(own) = own else {
		return true;
	};
	// A user press during a short SendInput batch is attributed to OMP.
	// A longer interval may include descheduling, so none of it is conclusive.
	at.saturating_sub(own.at) >= SEND_HISTORY
		|| own.after.wrapping_sub(own.before) > MAX_SEND_WINDOW_MS
		|| last.wrapping_sub(own.before) > own.after.wrapping_sub(own.before)
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

/// Stack room for the process's Raw Input registrations of every kind, where
/// a watch lists them; a process with more cannot have them listed there.
const LISTED: usize = 32;

/// How many Raw Input registrations of every kind the process has.
fn registered_devices() -> Option<usize> {
	let mut count = 0;
	// SAFETY: a null buffer asks only for the count.
	let failed = unsafe {
		GetRegisteredRawInputDevices(
			std::ptr::null_mut(),
			&raw mut count,
			size_of::<RAWINPUTDEVICE>() as u32,
		)
	} != 0;
	(!failed).then_some(count as usize)
}

/// The process's keyboard and mouse Raw Input registrations, whoever made
/// them, read into `room`; `None` when Windows cannot list them there.
fn registrations(room: &mut [RAWINPUTDEVICE]) -> Option<impl Iterator<Item = &RAWINPUTDEVICE>> {
	let read = if registered_devices()? == 0 {
		0
	} else {
		// Registrations made since the count still fit, up to the room.
		let mut count = room.len() as u32;
		// SAFETY: `room` holds `count` initialized entries.
		let read = unsafe {
			GetRegisteredRawInputDevices(
				room.as_mut_ptr(),
				&raw mut count,
				size_of::<RAWINPUTDEVICE>() as u32,
			)
		};
		if read == u32::MAX {
			return None;
		}
		read as usize
	};
	let listed = room.get(..read)?;
	Some(listed.iter().filter(|device| {
		device.usUsagePage == USAGE_PAGE && [KEYBOARD, MOUSE].contains(&device.usUsage)
	}))
}

/// Whether the process's keyboard and mouse registrations both still target
/// `window`; not when they cannot be listed. Runs at every check of a
/// listening takeover, so it lists them on the stack.
fn owns(window: HWND) -> bool {
	let mut listed = [RAWINPUTDEVICE::default(); LISTED];
	let Some(registered) = registrations(&mut listed) else {
		return false;
	};
	let mut owned = 0;
	for device in registered {
		if device.hwndTarget != window {
			return false;
		}
		owned += 1;
	}
	owned == 2
}

struct StopEvent(isize);

impl Drop for StopEvent {
	fn drop(&mut self) {
		// SAFETY: the last owner closes the event after the listener joins.
		unsafe { CloseHandle(self.0 as HANDLE) };
	}
}

/// The listener thread and the event that stops it; a polling watch has
/// neither.
struct Listener {
	running: Option<(thread::JoinHandle<CoreResult<()>>, Arc<StopEvent>)>,
}

impl Unregister for Listener {
	fn unregister(&mut self) -> CoreResult<()> {
		let Some((thread, stop)) = self.running.take() else {
			return Ok(());
		};
		// SAFETY: both owners retain this valid manual-reset event. Unlike a
		// posted message, signaling cannot fail because the queue is full.
		if unsafe { SetEvent(stop.0 as HANDLE) } == 0 {
			return Err(DesktopError::input_failed(
				"Windows input listener teardown failed: SetEvent failed; no further takeover can \
				 start until OMP restarts",
			));
		}
		thread.join().map_err(|_| {
			DesktopError::input_failed(
				"Windows input listener teardown failed: listener thread panicked; no further \
				 takeover can start until OMP restarts",
			)
		})?
	}
}

impl Drop for Listener {
	fn drop(&mut self) {
		let _ = self.unregister();
	}
}

/// Starts watching from `seen`, the last press an earlier registration saw,
/// or the session's history when that is newer.
fn listen(seen: Option<Duration>) -> CoreResult<(Arc<Presses>, Listener)> {
	// Windows keeps one keyboard and one mouse registration per process, and
	// none is OMP's while no watch is live: one that exists belongs to the
	// embedding host, which would stop receiving its input if it were
	// replaced. A host registering between this read and the registration
	// below still loses its own; one registering later blinds the watch,
	// which every check then reports.
	let mut listed = [RAWINPUTDEVICE::default(); LISTED];
	if registrations(&mut listed).is_none_or(|mut existing| existing.next().is_some()) {
		let sample = Sample::read().ok_or_else(|| unwatched(UNREADABLE))?;
		return Ok((Arc::new(Presses::polling(seen, sample)), Listener { running: None }));
	}

	// SAFETY: null security/name, manual reset, initially unsignaled.
	let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
	if event.is_null() {
		return Err(unwatched(UNREGISTERED));
	}
	let stop = Arc::new(StopEvent(event as isize));
	let stopping = Arc::clone(&stop);
	let presses = Arc::new(Presses::new(None, Watched::listening(owns)));
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
				// SAFETY: no live window uses this class, even when creation
				// failed.
				unsafe { UnregisterClassW(class.as_ptr(), std::ptr::null_mut()) };
				let _ = ready.send(None);
				return Ok(());
			}
			// Registration precedes the history sample, so input during thread
			// startup is covered by history or by the queue, never neither.
			// The window is published before any check can run.
			LISTENING.with_borrow(|presses| {
				if let Some(presses) = presses {
					if let Watched::Listening { window: target, .. } = &presses.watched {
						target.store(window as isize, Ordering::Release);
					}
					*presses.last.lock() = seen.max(Sample::read().and_then(Sample::press));
				}
			});
			let _ = ready.send(Some(()));
			// SAFETY: MSG is writable storage; the event lives through join.
			let mut message: MSG = unsafe { std::mem::zeroed() };
			let event = stopping.0 as HANDLE;
			'listening: loop {
				// SAFETY: one valid event; pump all queued input after waking.
				if unsafe { MsgWaitForMultipleObjects(1, &event, 0, INFINITE, QS_ALLINPUT) }
					!= WAIT_OBJECT_0 + 1
				{
					break;
				}
				loop {
					// SAFETY: checking the event between messages bounds shutdown
					// even when input arrives faster than the queue can drain.
					if unsafe { WaitForSingleObject(event, 0) } == WAIT_OBJECT_0 {
						break 'listening;
					}
					// SAFETY: this thread owns its queue and writable MSG.
					if unsafe { PeekMessageW(&raw mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) }
						== 0
					{
						break;
					}
					// SAFETY: this queue supplied the message.
					unsafe { DispatchMessageW(&raw const message) };
				}
			}
			// Removes only what this listener registered: a registration that
			// now targets another window was made since by someone else.
			// Teardown lists them all, however many there are.
			let count = registered_devices().unwrap_or_default();
			let mut listed = vec![RAWINPUTDEVICE::default(); count];
			let removed = registrations(&mut listed)
				.ok_or("reading the registrations failed")
				.and_then(|current| {
					let owned = current
						.filter(|device| device.hwndTarget == window)
						.map(|device| RAWINPUTDEVICE {
							dwFlags: RIDEV_REMOVE,
							hwndTarget: std::ptr::null_mut(),
							..*device
						})
						.collect::<Vec<_>>();
					// SAFETY: removal requires a null target. Both removal and
					// window destruction run on the thread which registered/created
					// them.
					let ok = owned.is_empty()
						|| unsafe {
							RegisterRawInputDevices(
								owned.as_ptr(),
								owned.len() as u32,
								size_of::<RAWINPUTDEVICE>() as u32,
							)
						} != 0;
					ok.then_some(()).ok_or("RIDEV_REMOVE failed")
				});
			// SAFETY: this thread owns the window and its class.
			let destroyed = unsafe { DestroyWindow(window) } != 0;
			// Destroying the target ends delivery even if removal fails, but
			// its stale registration is not clean: the joined result poisons
			// the watch state and refuses all later takeovers.
			// SAFETY: no live window uses the class after destruction.
			unsafe { UnregisterClassW(class.as_ptr(), std::ptr::null_mut()) };
			LISTENING.set(None);
			let failures = [removed.err(), (!destroyed).then_some("DestroyWindow failed")]
				.into_iter()
				.flatten()
				.collect::<Vec<_>>();
			if !failures.is_empty() {
				return Err(DesktopError::input_failed(format!(
					"Windows input listener teardown failed: {}; no further takeover can start until \
					 OMP restarts",
					failures.join(", "),
				)));
			}
			Ok(())
		})
		.map_err(|error| {
			DesktopError::input_failed(format!("cannot start watching the user's input: {error}"))
		})?;
	if receive_ready.recv() == Ok(Some(())) {
		Ok((presses, Listener { running: Some((thread, stop)) }))
	} else {
		let _ = thread.join();
		Err(unwatched(UNREGISTERED))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn presses(last: Option<Duration>) -> Presses {
		Presses::new(last, Watched::listening(|_| true))
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

	thread_local! {
		/// Whether this test thread's fake listener still holds the process's
		/// registrations.
		static OWNED: std::cell::Cell<bool> = const { std::cell::Cell::new(true) };
	}

	#[test]
	fn a_receiver_taken_during_a_takeover_stops_it_and_every_later_admission() {
		OWNED.set(true);
		let presses = Arc::new(Presses::new(None, Watched::listening(|_| OWNED.get())));
		let takeover =
			start_with((), Arc::clone(&presses), || Duration::ZERO, || false, |_| Ok(())).unwrap();
		check().unwrap();

		// A host registers the keyboard class: the user's next keys go to it,
		// and none reaches this watch's count.
		OWNED.set(false);
		let error = check().unwrap_err();
		assert_eq!(error.code, ErrorCode::InputFailed);
		assert!(error.message.contains("omp stopped seeing"), "{}", error.message);
		assert!(!error.message.contains("pressed"), "no press was seen: {}", error.message);
		let error =
			outcome(Err(DesktopError::input_failed("Windows refused the hand-back"))).unwrap_err();
		assert_eq!(error.code, ErrorCode::InputFailed);
		assert!(
			error
				.message
				.ends_with("; also failed: Windows refused the hand-back"),
			"{}",
			error.message
		);

		// The registration coming back does not make the watch whole again.
		OWNED.set(true);
		assert_eq!(check().unwrap_err().code, ErrorCode::InputFailed, "a lost watch stays lost");
		// A press the watch did see is still the outcome.
		presses.record(Duration::ZERO);
		assert_eq!(check().unwrap_err().code, ErrorCode::UserIntervened);
		drop(takeover);

		// Nothing is admitted on it any more, with or without the worker's
		// admission, and nothing is sent.
		let error =
			admit_with(&presses, Duration::ZERO, || Duration::ZERO, || false, |_| Ok(())).unwrap_err();
		assert_eq!(error.code, ErrorCode::InputFailed);
		assert!(error.message.contains("no takeover started"), "{}", error.message);
		ADMITTED.set(Some((Arc::clone(&presses), 1)));
		let error = start_with((), Arc::clone(&presses), || Duration::ZERO, || false, |_| Ok(()))
			.err()
			.expect("a blind watch admits nothing");
		assert_eq!(error.code, ErrorCode::InputFailed);
		assert!(ADMITTED.with_borrow(Option::is_none));
		assert!(ACTIVE.with_borrow(Option::is_none));
	}

	#[test]
	fn a_polling_watch_says_the_last_input_time_changed_not_that_the_user_pressed() {
		let presses = Arc::new(Presses::polling(None, Sample { tick: 0, now: 0, own: None }));
		ACTIVE.set(Some((Arc::clone(&presses), 0)));
		assert!(polled());
		assert_eq!(interruption(), INPUT_CHANGED);
		presses.record(Duration::ZERO);
		let error = check().unwrap_err();
		ACTIVE.set(None);
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert!(error.message.starts_with(INPUT_CHANGED), "{}", error.message);
		assert!(error.message.ends_with(POLLED), "{}", error.message);
		assert_eq!(interruption(), PRESSED, "outside a takeover");
	}

	#[test]
	fn one_sample_dates_input_on_one_clock_and_startup_skips_omps_own_send() {
		// GetTickCount64 just past a wrap of its low 32 bits.
		let now: u64 = (1 << 32) + 5;
		let sample = Sample { tick: u32::MAX - 4, now, own: None };
		assert_eq!(sample.press(), Some(Duration::from_millis(now - 10)));

		// OMP's own send was the session's last input as the watch started.
		let own = OwnSend {
			before: u32::MAX - 6,
			after:  u32::MAX - 3,
			at:     Duration::from_millis(now - 9),
		};
		let sample = Sample { own: Some(own), ..sample };
		assert_eq!(sample.press(), None);
		let seen = Some(Duration::from_secs(1));
		let presses = Presses::polling(seen, sample);
		assert_eq!(*presses.last.lock(), seen, "OMP's own send holds nothing back");
		let Watched::Polling(looked) = &presses.watched else {
			unreachable!("a polling watch");
		};
		presses.poll(&mut looked.lock(), sample);
		assert_eq!(presses.count.load(Ordering::Acquire), 0, "the baseline is the history's tick");
		// The user's input just after it counts, dated on the same clock.
		presses.poll(&mut looked.lock(), Sample { tick: 2, now: now + 1, own: Some(own) });
		assert_eq!(presses.count.load(Ordering::Acquire), 1);
		assert_eq!(*presses.last.lock(), Some(Duration::from_millis((1 << 32) + 2)));
	}

	struct Registration<'a>(&'a std::cell::Cell<usize>);

	impl Drop for Registration<'_> {
		fn drop(&mut self) {
			self.0.set(self.0.get() + 1);
		}
	}

	impl Unregister for Registration<'_> {
		fn unregister(&mut self) -> CoreResult<()> {
			Ok(())
		}
	}

	#[test]
	fn call_watches_balance_on_success_refusal_cancel_early_error_and_panic() {
		let registered = std::cell::Cell::new(0);
		let removed = std::cell::Cell::new(0);
		let watches = Watches::new();
		let register = |_| {
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
		assert_eq!(panic.unwrap_err().downcast_ref::<&str>(), Some(&"call panicked before input"));
		assert_eq!((registered.get(), removed.get()), (6, 6));
	}

	#[test]
	fn overlapping_watches_share_one_registration_until_the_last_drop() {
		let removed = std::cell::Cell::new(0);
		let watches = Watches::new();
		let first = watches
			.watch(|_| Ok((Arc::new(presses(None)), Registration(&removed))))
			.unwrap();
		let second = watches
			.watch(|_| panic!("must reuse the existing registration"))
			.unwrap();
		drop(first);
		assert_eq!(removed.get(), 0);
		drop(second);
		assert_eq!(removed.get(), 1);
	}

	#[test]
	fn history_suppresses_only_a_recent_send_window_including_tick_wrap() {
		let at = Duration::from_secs(100);
		let own = Some(OwnSend { before: 100, after: 102, at });
		assert!(user_tick(99, own, at));
		assert!(!user_tick(100, own, at));
		assert!(!user_tick(101, own, at));
		assert!(!user_tick(102, own, at));
		assert!(user_tick(103, own, at));
		assert!(user_tick(101, own, at + SEND_HISTORY));
		assert!(user_tick(101, own, at + Duration::from_hours(30 * 24)));
		assert!(user_tick(0, None, at), "no own input yet");
		let wrapped = Some(OwnSend { before: u32::MAX, after: 1, at });
		assert!(!user_tick(u32::MAX, wrapped, at));
		assert!(!user_tick(0, wrapped, at));
		assert!(!user_tick(1, wrapped, at));
		assert!(user_tick(u32::MAX - 1, wrapped, at));
		assert!(user_tick(2, wrapped, at));
		let delayed = Some(OwnSend { before: 100, after: 151, at });
		assert!(user_tick(125, delayed, at), "a descheduled sender cannot identify its input");
		let bounded = Some(OwnSend { before: 100, after: 150, at });
		assert!(!user_tick(125, bounded, at));
	}

	#[test]
	fn admission_from_a_dropped_registration_cannot_watch_a_new_takeover() {
		let removed = std::cell::Cell::new(0);
		let watches = Watches::new();
		let register = |_| Ok((Arc::new(presses(None)), Registration(&removed)));
		let first = watches.watch(register).unwrap();
		let clock = || Duration::from_secs(100);
		let count = admit_with(&first.presses, clock(), clock, || false, |_| Ok(())).unwrap();
		ADMITTED.set(Some((Arc::clone(&first.presses), count)));
		drop(first);
		let second = watches.watch(register).unwrap();
		let presses = Arc::clone(&second.presses);
		let error = start_with(second, presses, clock, || false, |_| Ok(()))
			.err()
			.expect("the admission belongs to a removed registration");
		assert_eq!(error.code, crate::desktop::error::ErrorCode::UserIntervened);
		assert!(ACTIVE.with_borrow(Option::is_none));
		assert_eq!(removed.get(), 2);
	}

	#[test]
	fn failed_removal_refuses_the_next_watch_without_registering_again() {
		struct FailedRemoval;
		impl Unregister for FailedRemoval {
			fn unregister(&mut self) -> CoreResult<()> {
				Err(DesktopError::input_failed("RIDEV_REMOVE failed"))
			}
		}
		let watches = Watches::new();
		let watch = watches
			.watch(|_| Ok((Arc::new(presses(None)), FailedRemoval)))
			.unwrap();
		drop(watch);
		let error = watches
			.watch(|_| panic!("a failed teardown must not register again"))
			.err()
			.expect("failed teardown must poison the next start");
		assert_eq!(error.code, crate::desktop::error::ErrorCode::InputFailed);
		assert!(error.message.contains("RIDEV_REMOVE"), "{}", error.message);
	}

	#[test]
	fn a_press_seen_before_the_last_watch_dropped_still_holds_the_next_admission() {
		let removed = std::cell::Cell::new(0);
		let watches = Watches::new();
		// The release OMP sent after the press is the session's last input, so
		// history has nothing of the user's to add.
		let register =
			|seen: Option<Duration>| Ok((Arc::new(presses(seen.max(None))), Registration(&removed)));
		let pressed = Duration::from_secs(100);
		let stopped = watches.watch(register).unwrap();
		stopped.presses.record(pressed);
		drop(stopped);
		assert_eq!(removed.get(), 1);

		let next = watches.watch(register).unwrap();
		let at = pressed + Duration::from_secs(1);
		let waited = std::cell::Cell::new(Duration::ZERO);
		admit_with(
			&next.presses,
			at + QUIET,
			|| at + waited.get(),
			|| false,
			|wait| {
				waited.set(waited.get() + wait);
				Ok(())
			},
		)
		.unwrap();
		assert_eq!(waited.get(), Duration::from_secs(4), "5 s from the press, not from the release");
	}

	#[test]
	fn a_press_keeps_what_else_failed_in_the_takeover() {
		let presses = Arc::new(presses(None));
		let takeover =
			start_with((), Arc::clone(&presses), || Duration::ZERO, || false, |_| Ok(())).unwrap();
		outcome(Err(DesktopError::input_failed("Windows refused the hand-back"))).unwrap_err();
		presses.record(Duration::ZERO);

		let error =
			outcome(Err(DesktopError::input_failed("SendInput could not release inserted input")))
				.unwrap_err();
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert!(error.message.contains("pressed a key or clicked"), "{}", error.message);
		assert!(
			error
				.message
				.ends_with("; also failed: SendInput could not release inserted input"),
			"{}",
			error.message
		);

		// A hold the press stopped already said its release failed.
		let held = "the user pressed a key or clicked during this takeover; cleanup also failed: \
		            SendInput could not release inserted input";
		let error = outcome(Err(DesktopError::user_intervened(held))).unwrap_err();
		assert_eq!((error.code, error.message.as_str()), (ErrorCode::UserIntervened, held));

		let error = outcome(Ok(())).unwrap_err();
		assert_eq!(error.code, ErrorCode::UserIntervened);
		drop(takeover);

		let error = with_press_for_test(|| outcome(Ok(()))).unwrap_err();
		assert_eq!(error.code, ErrorCode::UserIntervened);
		check().unwrap();
	}

	/// Real registrations are the process's own: tests making them take turns.
	static REAL: Mutex<()> = Mutex::new(());

	fn registered() -> Vec<(u16, u32, HWND)> {
		let mut listed = [RAWINPUTDEVICE::default(); LISTED];
		registrations(&mut listed)
			.unwrap()
			.map(|device| (device.usUsage, device.dwFlags, device.hwndTarget))
			.collect()
	}

	/// A keyboard receiver following the focus, as an embedding host might
	/// register; removed again on drop.
	struct Host;

	impl Host {
		fn register() -> Self {
			assert!(Self::change(0), "the host's registration");
			Self
		}

		fn change(flags: u32) -> bool {
			let device = RAWINPUTDEVICE {
				usUsagePage: USAGE_PAGE,
				usUsage:     KEYBOARD,
				dwFlags:     flags,
				hwndTarget:  std::ptr::null_mut(),
			};
			// SAFETY: one initialized device outlives the call.
			let changed = unsafe {
				RegisterRawInputDevices(&raw const device, 1, size_of::<RAWINPUTDEVICE>() as u32)
			};
			changed != 0
		}
	}

	impl Drop for Host {
		fn drop(&mut self) {
			Self::change(RIDEV_REMOVE);
		}
	}

	#[test]
	fn a_poll_counts_new_input_except_omps_own_and_keeps_the_newest_press() {
		let at = Duration::from_secs(100);
		let ms = 100_000;
		let own = Some(OwnSend { before: 20, after: 22, at });
		let presses = Presses::polling(Some(at), Sample { tick: 10, now: ms, own });
		let Watched::Polling(looked) = &presses.watched else {
			unreachable!("a polling watch");
		};
		let mut looked = looked.lock();
		presses.poll(&mut looked, Sample { tick: 10, now: ms, own });
		presses.poll(&mut looked, Sample { tick: 21, now: ms, own });
		assert_eq!(presses.count.load(Ordering::Acquire), 0, "unchanged, then OMP's own send");
		assert_eq!(*looked, 21);
		presses.poll(&mut looked, Sample { tick: 101_000, now: ms + 2_000, own });
		assert_eq!(presses.count.load(Ordering::Acquire), 1);
		assert_eq!(*presses.last.lock(), Some(at + Duration::from_secs(1)));
		// An older sample read late never moves the last press back.
		presses.record(at);
		assert_eq!(*presses.last.lock(), Some(at + Duration::from_secs(1)));
	}

	#[test]
	fn a_hosts_own_registration_is_left_in_place_and_the_watch_polls() {
		let _real = REAL.lock();
		let host_keyboard = [(KEYBOARD, 0, std::ptr::null_mut())];
		{
			let _host = Host::register();
			assert_eq!(registered(), host_keyboard);
			{
				let call = UserActivity::start().unwrap();
				assert!(call.0.presses.polled(), "a host's receiver is never replaced");
				assert_eq!(registered(), host_keyboard);
			}
			assert_eq!(registered(), host_keyboard, "nothing of the host's is removed");
		}
		assert!(registered().is_empty());

		// A host that registers while OMP listens keeps its receiver, and the
		// watch, which no longer sees the user's keys, says so.
		let call = UserActivity::start().unwrap();
		assert!(!call.0.presses.polled());
		assert_eq!(registered().len(), 2);
		call.0.presses.refresh().unwrap();
		let _host = Host::register();
		assert_eq!(call.0.presses.refresh(), Err(LOST), "the host's keyboard blinds the watch");
		drop(call);
		assert_eq!(registered(), host_keyboard);
	}

	#[test]
	fn real_registration_is_removed_after_last_drop_cancel_and_unwind() {
		let _real = REAL.lock();
		assert!(registered().is_empty());
		let first = UserActivity::start().unwrap();
		assert_eq!(registered().len(), 2);
		let second = UserActivity::start().unwrap();
		drop(first);
		assert_eq!(registered().len(), 2);
		drop(second);
		assert!(registered().is_empty(), "removal must not merely destroy the target window");

		let source = control::CancellationSource::default();
		let token = source.token();
		let cancelled = control::with_token_for_test(&token, || -> CoreResult<()> {
			let _call = UserActivity::start()?;
			source.cancel();
			control::check()
		});
		assert_eq!(cancelled.unwrap_err().code, crate::desktop::error::ErrorCode::Cancelled);
		assert!(registered().is_empty());

		let panic = std::panic::catch_unwind(|| {
			let _call = UserActivity::start().unwrap();
			panic!("unwind a real call-scope watch");
		});
		assert_eq!(
			panic.unwrap_err().downcast_ref::<&str>(),
			Some(&"unwind a real call-scope watch")
		);
		assert!(registered().is_empty());
	}
}
