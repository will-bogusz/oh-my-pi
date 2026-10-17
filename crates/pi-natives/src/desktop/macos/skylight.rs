use std::{
	cell::Cell,
	ffi::c_void,
	ptr,
	sync::{
		LazyLock,
		atomic::{AtomicBool, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use core_graphics::{event::CGEvent, geometry::CGPoint};
use foreign_types::ForeignType;
use libc::pid_t;
use objc2_core_foundation::{CFArray, CFDictionary, CFNumber, CFRetained, CFString, CFType};

use super::{
	super::{
		control,
		error::{CoreResult, DesktopError},
		types::DesktopFocusReturn,
	},
	ax, capture, process,
	release::Route,
	release_guard,
	route::{self, Routes, symbol},
};

const EVENT_RECORD_LENGTH: usize = 248;
const EVENT_RECORD_LENGTH_BYTE: u8 = 0xf8;
const EVENT_RECORD_KIND: u8 = 0x0d;
const WINDOW_ID_OFFSET: usize = 0x3c;
const FOCUS_MARKER_OFFSET: usize = 0x8a;
const FOCUS_MARKER: u8 = 0x01;
/// `kCPSUserGenerated`: lets `AppKit` install the requested native key window.
const CPS_USER_GENERATED: u32 = 0x200;
/// `kCPSNoWindows`: changes the front process without raising its windows.
const CPS_NO_WINDOWS: u32 = 0x400;
/// Covers delayed AX/AppKit activation after the synchronous action returns.
/// The lease is joined before returning; it never continues fighting the user.
const BACKGROUND_SETTLE: Duration = Duration::from_millis(200);
/// Upper bound on waiting for a foreground activation to become observable.
const ACTIVATION_TIMEOUT: Duration = Duration::from_millis(400);
const ACTIVATION_POLL: Duration = Duration::from_millis(10);
/// Keeps the target frontmost until it has consumed foreground input.
const FOREGROUND_SETTLE: Duration = Duration::from_millis(40);
/// `SLSSetFrontProcessWithInfo`'s result when a user key press or click was
/// dispatched after the request's timestamp.
const EXPIRED_FRONT_REQUEST: i32 = -13066;

unsafe extern "C" {
	fn CGEventSourceCounterForEventType(state: i32, event_type: u32) -> u32;
}

#[repr(C)]
#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct ProcessSerialNumber {
	high: u32,
	low:  u32,
}

type SLPSPostEventRecordToFn = unsafe extern "C" fn(*const ProcessSerialNumber, *const u8) -> i32;
type SLPSGetFrontProcessFn = unsafe extern "C" fn(*mut ProcessSerialNumber) -> i32;
type CGSMainConnectionIDFn = unsafe extern "C" fn() -> u32;
type SLSGetWindowOwnerFn = unsafe extern "C" fn(u32, u32, *mut u32) -> i32;
type SLSGetConnectionPSNFn = unsafe extern "C" fn(u32, *mut ProcessSerialNumber) -> i32;
type GetProcessForPIDFn = unsafe extern "C" fn(pid_t, *mut ProcessSerialNumber) -> i32;
type GetProcessPIDFn = unsafe extern "C" fn(*const ProcessSerialNumber, *mut pid_t) -> i32;
type CGEventSetWindowLocationFn = unsafe extern "C" fn(*mut c_void, CGPoint);
type SLPSSetFrontProcessWithOptionsFn =
	unsafe extern "C" fn(*const ProcessSerialNumber, u32, u32) -> i32;
type SLSSetFrontProcessWithInfoFn =
	unsafe extern "C" fn(*const ProcessSerialNumber, u32, u32, *const c_void) -> i32;

#[derive(Clone, Copy)]
struct PsnLookup {
	main_connection:     Option<CGSMainConnectionIDFn>,
	get_window_owner:    Option<SLSGetWindowOwnerFn>,
	get_connection_psn:  Option<SLSGetConnectionPSNFn>,
	get_process_for_pid: Option<GetProcessForPIDFn>,
}

impl PsnLookup {
	fn can_resolve(self) -> bool {
		(self.main_connection.is_some()
			&& self.get_window_owner.is_some()
			&& self.get_connection_psn.is_some())
			|| self.get_process_for_pid.is_some()
	}
}

#[derive(Clone, Copy)]
struct RequiredSpi {
	routes:              &'static Routes,
	set_window_location: CGEventSetWindowLocationFn,
	main_connection:     CGSMainConnectionIDFn,
}

#[derive(Clone, Copy)]
struct ForegroundSpi {
	set_front:   SLPSSetFrontProcessWithOptionsFn,
	get_front:   SLPSGetFrontProcessFn,
	post_record: SLPSPostEventRecordToFn,
	psn:         PsnLookup,
	conditional: Option<ConditionalFront>,
}

/// The front-process request `WindowServer` refuses when the user pressed a
/// key or clicked after the request's timestamp.
#[derive(Clone, Copy)]
struct ConditionalFront {
	set_front:     SLSSetFrontProcessWithInfoFn,
	/// `kSLSSetFrontProcessRequestTimestampKey`, a process-lived `CFString`.
	timestamp_key: *const CFString,
}

// SAFETY: `timestamp_key` points at an immutable, process-lived CFString
// constant exported by SkyLight.
unsafe impl Send for ConditionalFront {}
// SAFETY: as above; the pointee is never mutated.
unsafe impl Sync for ConditionalFront {}

/// The front process as `WindowServer` reports it. Unlike
/// `NSWorkspace.frontmostApplication`, this does not depend on an `AppKit`
/// run loop in this process observing activation changes.
#[derive(Clone, Copy)]
struct FrontProcess {
	psn: ProcessSerialNumber,
	pid: Option<pid_t>,
}

static REQUIRED: LazyLock<Option<RequiredSpi>> = LazyLock::new(resolve_required);
static FOREGROUND: LazyLock<Option<ForegroundSpi>> = LazyLock::new(resolve_foreground);
static PROCESS_PID: LazyLock<Option<GetProcessPIDFn>> = LazyLock::new(|| symbol(c"GetProcessPID"));

pub(super) fn is_available() -> bool {
	required().is_ok() && takeover_available()
}

pub(super) fn takeover_available() -> bool {
	FOREGROUND.is_some() && PROCESS_PID.is_some()
}

fn required() -> CoreResult<&'static RequiredSpi> {
	REQUIRED.as_ref().ok_or_else(|| {
		DesktopError::background_unavailable(
			"skylight-spi-missing: required SkyLight background input symbols are unavailable",
		)
	})
}

fn resolve_required() -> Option<RequiredSpi> {
	Some(RequiredSpi {
		routes:              route::routes()?,
		set_window_location: symbol(c"CGEventSetWindowLocation")?,
		main_connection:     symbol(c"CGSMainConnectionID")?,
	})
}

fn resolve_foreground() -> Option<ForegroundSpi> {
	route::load_skylight()?;
	let psn = PsnLookup {
		main_connection:     symbol(c"CGSMainConnectionID"),
		get_window_owner:    symbol(c"SLSGetWindowOwner"),
		get_connection_psn:  symbol(c"SLSGetConnectionPSN"),
		get_process_for_pid: symbol(c"GetProcessForPID"),
	};
	if !psn.can_resolve() {
		return None;
	}
	Some(ForegroundSpi {
		set_front: symbol(c"_SLPSSetFrontProcessWithOptions")?,
		get_front: symbol(c"_SLPSGetFrontProcess")?,
		post_record: symbol(c"SLPSPostEventRecordTo")?,
		psn,
		conditional: resolve_conditional_front(),
	})
}

fn resolve_conditional_front() -> Option<ConditionalFront> {
	let key: *const *const CFString = symbol(c"kSLSSetFrontProcessRequestTimestampKey")?;
	// SAFETY: the exported symbol is a `CFStringRef` variable that SkyLight
	// initializes before any of its functions can be called.
	let timestamp_key = unsafe { key.read() };
	if timestamp_key.is_null() {
		return None;
	}
	Some(ConditionalFront { set_front: symbol(c"SLSSetFrontProcessWithInfo")?, timestamp_key })
}

fn event_ptr(event: &CGEvent) -> *mut c_void {
	event.as_ptr().cast()
}

/// Stamps raw `SkyLight` integer event fields onto `event`.
pub(super) fn set_fields(event: &CGEvent, fields: &[(u32, i64)]) -> CoreResult<()> {
	let routes = required()?.routes;
	let ptr = event_ptr(event);
	for &(field, value) in fields {
		// SAFETY: The event is alive for the call.
		unsafe { routes.set_field(ptr, field, value) };
	}
	Ok(())
}

/// Stamps a window-local point, measured from the window's top-left including
/// its title bar, for hit-testing a pid-addressed pointer event.
pub(super) fn set_window_location(event: &CGEvent, location: CGPoint) -> CoreResult<()> {
	let spi = required()?;
	// SAFETY: The event is alive for the call and the setter passed the atomic
	// exact-signature probe.
	unsafe { (spi.set_window_location)(event_ptr(event), location) };
	Ok(())
}

/// Posts a pointer event through `SkyLight` alone (see [`Routes::routed`]).
pub(super) fn post_routed(pid: pid_t, event: &CGEvent) -> CoreResult<()> {
	post_to_pid(Route::Routed(pid), event, |routes, event| {
		// SAFETY: `post_to_pid` passes the live event it retains for the call.
		unsafe { routes.routed(pid, event) };
		Ok(())
	})
}

/// Posts a background pointer event through `SkyLight` and, where it is a
/// separate function, the public per-pid queue (see [`Routes::public`]).
pub(super) fn post_dual(pid: pid_t, event: &CGEvent) -> CoreResult<()> {
	post_to_pid(Route::Dual(pid), event, |routes, event| {
		// SAFETY: `post_to_pid` passes the live event it retains for the call.
		unsafe { routes.routed(pid, event) };
		control::check()?;
		// SAFETY: as above.
		unsafe { routes.public(pid, event) };
		Ok(())
	})
}

/// Posts a keyboard event on the authenticated `SkyLight` route (see
/// [`Routes::keyboard`]).
pub(super) fn post_keyboard(pid: pid_t, event: &CGEvent) -> CoreResult<()> {
	post_to_pid(Route::Keyboard(pid), event, |routes, event| {
		// SAFETY: `post_to_pid` passes the live event it retains for the call.
		unsafe { routes.keyboard(pid, event) };
		Ok(())
	})
}

/// Posts `event`, tagged as synthetic, through `post` on `route`, telling the
/// input request's release helper what it holds. `post` receives a live
/// event, retained for the synchronous call.
fn post_to_pid(
	route: Route,
	event: &CGEvent,
	post: impl FnOnce(&Routes, *mut c_void) -> CoreResult<()>,
) -> CoreResult<()> {
	control::check()?;
	event.set_integer_value_field(
		core_graphics::event::EventField::EVENT_SOURCE_USER_DATA,
		control::SYNTHETIC_EVENT_TAG,
	);
	let routes = required()?.routes;
	release_guard::post(route, event, || post(routes, event_ptr(event)))
}

/// This process's `WindowServer` connection, which `AppKit` stamps on the
/// window events it builds as their window context.
pub(super) fn sender_connection() -> CoreResult<i64> {
	let spi = required()?;
	// SAFETY: The no-argument connection query was resolved with its exact
	// signature.
	Ok(i64::from(unsafe { (spi.main_connection)() }))
}

/// The 248-byte focus event record addressed to window `wid`.
fn focus_record(wid: u32) -> [u8; EVENT_RECORD_LENGTH] {
	let mut record = [0u8; EVENT_RECORD_LENGTH];
	record[0x04] = EVENT_RECORD_LENGTH_BYTE;
	record[0x08] = EVENT_RECORD_KIND;
	record[WINDOW_ID_OFFSET..WINDOW_ID_OFFSET + 4].copy_from_slice(&wid.to_le_bytes());
	record[FOCUS_MARKER_OFFSET] = FOCUS_MARKER;
	record
}

/// One of the paired records (`kind` 0x01, then 0x02) that make window `wid`
/// the native key window of its process.
fn make_key_record(wid: u32, kind: u8) -> [u8; EVENT_RECORD_LENGTH] {
	let mut record = [0u8; EVENT_RECORD_LENGTH];
	record[0x04] = EVENT_RECORD_LENGTH_BYTE;
	record[0x08] = kind;
	record[0x20..0x30].fill(0xff);
	record[0x3a] = 0x10;
	record[WINDOW_ID_OFFSET..WINDOW_ID_OFFSET + 4].copy_from_slice(&wid.to_le_bytes());
	record
}

fn post_record(
	post: SLPSPostEventRecordToFn,
	psn: ProcessSerialNumber,
	record: &[u8; EVENT_RECORD_LENGTH],
) -> bool {
	// SAFETY: The PSN and the complete 248-byte record live through the
	// synchronous SPI call.
	unsafe { post(&psn, record.as_ptr()) == 0 }
}

fn front_process(get_front: SLPSGetFrontProcessFn) -> Option<FrontProcess> {
	let mut psn = ProcessSerialNumber::default();
	// SAFETY: `psn` is writable and exactly the 8-byte PSN record expected by
	// this SPI.
	if unsafe { get_front(&mut psn) } != 0 {
		return None;
	}
	let pid = (*PROCESS_PID).and_then(|get_pid| {
		let mut pid: pid_t = 0;
		// SAFETY: Both pointers are valid for the synchronous lookup and the
		// symbol has the exact GetProcessPID ABI.
		(unsafe { get_pid(&psn, &mut pid) } == 0 && pid > 0).then_some(pid)
	});
	Some(FrontProcess { psn, pid })
}

/// Joins the action and its cleanup without hiding a failed restoration or
/// encouraging an unsafe blind retry of an action that may already have landed.
pub(super) fn after_cleanup<T>(result: CoreResult<T>, cleanup: CoreResult<()>) -> CoreResult<T> {
	match (result, cleanup) {
		(result, Ok(())) => result,
		(Ok(_), Err(error)) => Err(DesktopError::input_failed(format!(
			"input may already have been delivered, but restoration failed: {error}; inspect the \
			 desktop before retrying"
		))),
		(Err(action), Err(cleanup)) => Err(DesktopError::input_failed(format!(
			"{action}; restoration also failed: {cleanup}; inspect the desktop before retrying"
		))),
	}
}

/// Physical activity is a conservative veto, not proof of which app the user
/// chose. A source that updates HID counters for synthetic events can also veto
/// restoration; yielding control is safer than fighting a deliberate switch.
fn activation_activity() -> [u32; 5] {
	// Left/right/other press, key press, and modifiers can change activation.
	[1, 3, 25, 10, 12].map(|event_type| {
		// SAFETY: HIDSystemState (1) and these public CGEventType values are
		// defined by CGEventSource.h / CGEventTypes.h; this is a read-only query.
		unsafe { CGEventSourceCounterForEventType(1, event_type) }
	})
}

/// Left, right and other mouse presses the HID system has counted.
fn pointer_presses() -> [u32; 3] {
	[1, 3, 25].map(|event_type| {
		// SAFETY: HIDSystemState (1) and these public CGEventType values are
		// defined by CGEventSource.h / CGEventTypes.h; this is a read-only query.
		unsafe { CGEventSourceCounterForEventType(1, event_type) }
	})
}

#[derive(Debug, PartialEq, Eq)]
enum FocusDecision {
	Observe,
	Restore,
	Disarm,
}

/// Once the user changes the front app/window, later target activations cannot
/// resurrect this action's old focus claim.
struct BackgroundFocusLease {
	previous: ProcessSerialNumber,
	target:   ProcessSerialNumber,
	/// The user's key window; `None` when the front app showed no window.
	key:      Option<u32>,
	activity: [u32; 5],
	disarmed: bool,
}

impl BackgroundFocusLease {
	fn observe(
		&mut self,
		front: ProcessSerialNumber,
		key: Option<u32>,
		activity: [u32; 5],
	) -> FocusDecision {
		if self.disarmed
			|| (front != self.previous && front != self.target)
			|| (front == self.previous && key.is_some_and(|key| Some(key) != self.key))
			|| (front == self.target && activity != self.activity)
		{
			self.disarmed = true;
			return FocusDecision::Disarm;
		}
		if front == self.target {
			FocusDecision::Restore
		} else {
			// Input while the user's original window is still frontmost is not
			// a focus change. Remember it so a later app reflex can be contained.
			self.activity = activity;
			FocusDecision::Observe
		}
	}
}

/// Contains asynchronous self-activation during background input and its
/// bounded post-action settle, without a process-lived observer or run loop.
/// A third app, changed prior key window, or new hardware input permanently
/// disarms the lease. Only the addressed target can be sent back behind the
/// original front app; unlike cua's wildcard suppressor, unrelated activations
/// are never undone.
pub(super) fn with_background_guard<T>(
	pid: pid_t,
	action: impl FnOnce() -> CoreResult<T>,
) -> CoreResult<T> {
	control::check()?;
	let spi = FOREGROUND.as_ref().ok_or_else(|| {
		DesktopError::background_unavailable(
			"the focus-restoration SPI is unavailable, so background input could not keep the user's \
			 focus; nothing was sent",
		)
	})?;
	let previous = front_process(spi.get_front).ok_or_else(|| {
		DesktopError::background_unavailable(
			"cannot establish the current front process before background input; nothing was sent",
		)
	})?;
	if previous.pid == Some(pid) {
		return action();
	}
	let target = process_psn(spi.psn, pid, 0).ok_or_else(|| {
		DesktopError::background_unavailable(
			"cannot resolve the background target process; nothing was sent",
		)
	})?;
	let previous_key = previous
		.pid
		.and_then(restoration_key)
		.ok_or_else(|| {
			DesktopError::background_unavailable(
				"cannot establish the user's key window for background focus restoration; nothing was \
				 sent",
			)
		})?
		.window();
	let mut lease = BackgroundFocusLease {
		previous: previous.psn,
		target,
		key: previous_key,
		activity: activation_activity(),
		disarmed: false,
	};
	let stopped = AtomicBool::new(false);
	thread::scope(|scope| {
		let stop = &stopped;
		let observer = thread::Builder::new()
			.name("desktop-focus-lease".to_string())
			.spawn_scoped(scope, move || -> CoreResult<()> {
				let mut restored = false;
				loop {
					let Some(front) = front_process(spi.get_front) else {
						return Err(DesktopError::input_failed(
							"lost the front process during background input",
						));
					};
					let key = if front.psn == previous.psn {
						previous.pid.and_then(ax::key_window_id)
					} else {
						None
					};
					match lease.observe(front.psn, key, activation_activity()) {
						FocusDecision::Disarm => return Ok(()),
						FocusDecision::Observe => {},
						FocusDecision::Restore => {
							// Re-check immediately before changing focus: an AX probe
							// may have raced a newer application or hardware event.
							// `WindowServer` then refuses the hand-back if the user
							// pressed a key or clicked after the re-check began.
							let handed_back = request_after_check(
								event_clock_now,
								|| {
									front_process(spi.get_front).is_some_and(|front| front.psn == target)
										&& activation_activity() == lease.activity
								},
								|since| {
									set_front_unless_user_acted(
										spi,
										previous.psn,
										previous_key.unwrap_or(0),
										since,
									)
								},
							)?;
							match handed_back {
								None => {},
								// The user brought the target forward themselves.
								Some(FrontRequest::UserActed) => return Ok(()),
								Some(FrontRequest::Done) => {
									restored = true;
									if let Some(key) = previous_key
										&& !post_record(spi.post_record, previous.psn, &focus_record(key))
									{
										return Err(DesktopError::input_failed(
											"background key-window restoration was rejected",
										));
									}
								},
							}
						},
					}
					if stop.load(Ordering::Acquire) {
						if restored
							&& front_process(spi.get_front).is_some_and(|front| front.psn == target)
						{
							return Err(DesktopError::input_failed(
								"the background target reactivated after focus restoration; input may \
								 already have landed; inspect the desktop before sending more",
							));
						}
						return Ok(());
					}
					thread::park_timeout(ACTIVATION_POLL);
				}
			})
			.map_err(|error| {
				DesktopError::background_unavailable(format!(
					"could not start the background focus guard: {error}; nothing was sent"
				))
			})?;
		struct StopObserver<'a> {
			stopped: &'a AtomicBool,
			thread:  thread::Thread,
		}
		impl Drop for StopObserver<'_> {
			fn drop(&mut self) {
				self.stopped.store(true, Ordering::Release);
				self.thread.unpark();
			}
		}
		let stop = StopObserver { stopped: &stopped, thread: observer.thread().clone() };
		let result = run_then_settle(action, || control::wait(BACKGROUND_SETTLE));
		drop(stop);
		let cleanup = observer.join().unwrap_or_else(|_| {
			Err(DesktopError::input_failed("background focus guard terminated unexpectedly"))
		});
		after_cleanup(result, cleanup)
	})
}

/// Runs a guarded action, then the settle during which the guard still sends
/// back an app the action brought forward. The settle follows a failed action
/// too: an AX action can report an error and still activate its app, as
/// `AXOpen` on a file in Chrome's Open panel fails with -25205 within 20 ms
/// and Chrome comes to the front some 20 ms later. The action's own error wins
/// over the settle's.
fn run_then_settle<T>(
	action: impl FnOnce() -> CoreResult<T>,
	settle: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<T> {
	let result = action();
	let settled = settle();
	result.and_then(|value| settled.map(|()| value))
}

fn set_front(spi: &ForegroundSpi, psn: ProcessSerialNumber, wid: u32) -> CoreResult<()> {
	control::check()?;
	// SAFETY: The PSN was resolved from WindowServer. kCPSNoWindows changes
	// only the front process; no activate-all-windows fallback is permitted.
	if unsafe { (spi.set_front)(&psn, wid, CPS_NO_WINDOWS) } != 0 {
		return Err(DesktopError::input_failed(
			"WindowServer rejected front-process restoration/activation",
		));
	}
	Ok(())
}

/// What a front-process request through [`set_front_unless_user_acted`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FrontRequest {
	Done,
	/// `WindowServer` refused it: the user pressed a key or clicked after its
	/// timestamp, so the front application is theirs.
	UserActed,
}

/// Now on the clock `WindowServer` compares a front-process request's
/// timestamp with: nanoseconds of `CLOCK_UPTIME_RAW`.
fn event_clock_now() -> u64 {
	let mut time = libc::timespec { tv_sec: 0, tv_nsec: 0 };
	// SAFETY: `time` is writable for the call; CLOCK_UPTIME_RAW is a clock
	// every supported macOS provides, and the call retains no pointer.
	unsafe { libc::clock_gettime(libc::CLOCK_UPTIME_RAW, &raw mut time) };
	u64::try_from(time.tv_sec).unwrap_or(0) * 1_000_000_000
		+ u64::try_from(time.tv_nsec).unwrap_or(0)
}

/// Runs `request` with a timestamp taken from `now` before `still_ours`
/// confirms the hand-back is still wanted; `None` when it no longer is.
/// `WindowServer` refuses the request if the user pressed a key or clicked
/// after that timestamp, so input arriving between the check and the request
/// vetoes it as well.
fn request_after_check(
	now: impl FnOnce() -> u64,
	still_ours: impl FnOnce() -> bool,
	request: impl FnOnce(u64) -> CoreResult<FrontRequest>,
) -> CoreResult<Option<FrontRequest>> {
	let since = now();
	if !still_ours() {
		return Ok(None);
	}
	request(since).map(Some)
}

/// How many timestamps takeover's hand-back tries while the user keeps typing.
const TAKEOVER_HAND_BACK_TRIES: usize = 3;

/// Takeover's hand-back through [`request_after_check`], asked again with a
/// fresh timestamp while `WindowServer` refuses it and `typed_since` shows the
/// takeover monitor saw the user type after the refused timestamp. Such
/// typing reached the target only because takeover held the front. A refusal
/// the monitor cannot account for (a click or shortcut it has not counted
/// yet, or no monitor at all) stands, as does any try `still_ours` rejects.
fn hand_back_through_typing(
	mut now: impl FnMut() -> u64,
	mut still_ours: impl FnMut() -> bool,
	mut typed_since: impl FnMut(u64) -> bool,
	mut request: impl FnMut(u64) -> CoreResult<FrontRequest>,
) -> CoreResult<Option<FrontRequest>> {
	for _ in 1..TAKEOVER_HAND_BACK_TRIES {
		let mut asked = 0;
		let handed = request_after_check(&mut now, &mut still_ours, |since| {
			asked = since;
			request(since)
		})?;
		if handed != Some(FrontRequest::UserActed) || !typed_since(asked) {
			return Ok(handed);
		}
	}
	request_after_check(now, still_ours, request)
}

/// Makes `psn` the front process unless the user pressed a key or clicked
/// after `since` ([`event_clock_now`]). `WindowServer` decides on its own
/// event clock, so polling delays cannot hide that input; events posted to a
/// process, as background input is, do not count. Where the conditional
/// request is unavailable, the front process changes unconditionally.
fn set_front_unless_user_acted(
	spi: &ForegroundSpi,
	psn: ProcessSerialNumber,
	wid: u32,
	since: u64,
) -> CoreResult<FrontRequest> {
	let Some(conditional) = spi.conditional else {
		return set_front(spi, psn, wid).map(|()| FrontRequest::Done);
	};
	control::check()?;
	let timestamp = CFNumber::new_i64(i64::try_from(since).unwrap_or(i64::MAX));
	// SAFETY: `timestamp_key` is SkyLight's process-lived CFString constant.
	let key = unsafe { &*conditional.timestamp_key };
	let info = CFDictionary::<CFString, CFNumber>::from_slices(&[key], &[&*timestamp]);
	// SAFETY: The PSN was resolved from WindowServer and `info` stays alive
	// for the synchronous call. kCPSNoWindows changes only the front process.
	let status =
		unsafe { (conditional.set_front)(&psn, wid, CPS_NO_WINDOWS, ptr::from_ref(&*info).cast()) };
	front_request(status)
}

fn front_request(status: i32) -> CoreResult<FrontRequest> {
	match status {
		0 => Ok(FrontRequest::Done),
		EXPIRED_FRONT_REQUEST => Ok(FrontRequest::UserActed),
		_ => Err(DesktopError::input_failed(
			"WindowServer rejected front-process restoration/activation",
		)),
	}
}

/// What the user's front application gets back after input elsewhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UserKey {
	Window(u32),
	/// It provably shows no window, as Finder after a click on the desktop or
	/// an app that just closed its last window: only the front process is
	/// restored.
	Windowless,
}

impl UserKey {
	const fn window(self) -> Option<u32> {
		match self {
			Self::Window(id) => Some(id),
			Self::Windowless => None,
		}
	}
}

/// The front application `pid`'s [`UserKey`]; `None` when neither its key
/// window nor its windowlessness can be established.
fn restoration_key(pid: pid_t) -> Option<UserKey> {
	restorable_key(
		ax::key_window_id(pid),
		|| ax::window_records(pid).map(|records| records.iter().any(|record| record.id.is_some())),
		|| capture::has_onscreen_window(pid),
	)
}

/// [`restoration_key`]'s decision: an app with no key window counts as
/// windowless only when both its accessibility windows (Finder's unmappable
/// desktop entry aside) and `WindowServer`'s on-screen list show none of its
/// windows. An unreadable answer from either refuses.
fn restorable_key(
	key: Option<u32>,
	ax_lists_window: impl FnOnce() -> Option<bool>,
	shows_window: impl FnOnce() -> Option<bool>,
) -> Option<UserKey> {
	if let Some(key) = key {
		return Some(UserKey::Window(key));
	}
	(ax_lists_window() == Some(false) && shows_window() == Some(false))
		.then_some(UserKey::Windowless)
}

/// Makes `wid` the frontmost key window, runs `action`, then restores the
/// previous front process (or, within one process, its previous key window).
///
/// `action` receives whether focus actually moved, so keyboard delivery can
/// give a just-activated surface time to arm its input handling. A target that
/// already is the key window of the front process is not re-activated:
/// re-activating it can clear Chromium's renderer focus. The window is made
/// key without being raised; callers that need it unobstructed raise it.
/// `return_focus` restores even after user input during the action; see
/// [`hands_focus_back`].
pub(super) fn with_foreground<T>(
	pid: pid_t,
	wid: u32,
	return_focus: bool,
	action: impl FnOnce(bool) -> CoreResult<T>,
) -> CoreResult<T> {
	control::check()?;
	let choices = control::user_choices();
	let user_acted = || control::user_choices() != choices;
	let spi = FOREGROUND.as_ref().ok_or_else(|| {
		DesktopError::input_failed("exact-window takeover SPI is unavailable; no input was sent")
	})?;
	let previous = front_process(spi.get_front).ok_or_else(|| {
		DesktopError::input_failed(
			"cannot identify the front process for takeover restoration; no input was sent",
		)
	})?;
	let target = process_psn(spi.psn, pid, wid).ok_or_else(|| {
		DesktopError::input_failed("cannot resolve the exact takeover target; no input was sent")
	})?;
	let focused = ax::focused_window_id(pid);
	if preserves_exact_existing_focus(Some(previous.psn), target, focused, wid) {
		let result = action(false).and_then(|value| control::wait(FOREGROUND_SETTLE).map(|()| value));
		report_focus_return(false, previous.pid);
		return result;
	}
	let previous_pid = previous.pid.ok_or_else(|| {
		DesktopError::input_failed(
			"cannot identify the previous application for takeover restoration; no input was sent",
		)
	})?;
	let previous_key = restoration_key(previous_pid)
		.ok_or_else(|| {
			DesktopError::input_failed(
				"cannot identify the previous key window for takeover restoration; no input was sent",
			)
		})?
		.window();
	let handed_back = Cell::new(false);
	let restore = || {
		if !return_focus && user_acted() {
			return Ok(());
		}
		let front = front_process(spi.get_front).ok_or_else(|| {
			DesktopError::input_failed("cannot establish current focus for takeover restoration")
		})?;
		let now = if front.psn == target {
			FocusAfterTakeover::Target
		} else {
			FocusAfterTakeover::Elsewhere
		};
		if !hands_focus_back(return_focus, user_acted(), now) {
			return Ok(());
		}
		// Keys the user types while takeover holds the front land in the target
		// without them choosing it, so only a click or Command shortcut of
		// theirs, or a switch elsewhere, leaves the front application alone.
		// Takeover's own clicks are over, so a pointer press the HID counters
		// show after this point is the user's; they are read synchronously,
		// unlike the monitor's count, which can trail a click.
		let presses = pointer_presses();
		let still_ours = || {
			(return_focus || !user_acted())
				&& pointer_presses() == presses
				// A user-selected third app must not be overwritten.
				&& front_process(spi.get_front).is_some_and(|now| now.psn == target)
		};
		// The action and its settle are over, so takeover's own keys and
		// clicks, which `WindowServer` counts like the user's, came before this
		// timestamp; user input after it refuses the hand-back, and the
		// make-key records below are then never posted.
		let request = hand_back_through_typing(
			event_clock_now,
			still_ours,
			|since| control::last_user_typing() >= since,
			|since| set_front_unless_user_acted(spi, previous.psn, previous_key.unwrap_or(0), since),
		)?;
		if request != Some(FrontRequest::Done) {
			return Ok(());
		}
		// A previous app that showed no window gets only its front status back.
		let Some(previous_key) = previous_key else {
			handed_back.set(true);
			return Ok(());
		};
		// Returning to an app often reinstates its original key window by
		// itself. Re-making an already-key Chromium window can clear the user's
		// renderer focus, just as reactivating an already-key input target can.
		if ax::focused_window_id(previous_pid) != Some(previous_key) {
			make_exact_window_key(spi, previous.psn, previous_key)?;
		}
		await_window_focused(spi, previous_pid, previous_key, previous.psn)?;
		handed_back.set(true);
		Ok(())
	};
	let prepare = set_front(spi, target, wid)
		.and_then(|()| make_exact_window_key(spi, target, wid))
		.and_then(|()| await_window_focused(spi, pid, wid, target));
	let result = if let Err(error) = prepare {
		after_cleanup(Err(error), control::cleanup(restore))
	} else {
		let result = action(true).and_then(|value| control::wait(FOREGROUND_SETTLE).map(|()| value));
		after_cleanup(result, control::cleanup(restore))
	};
	report_focus_return(handed_back.get(), previous.pid);
	result
}

/// Records for the host where a takeover left focus, read from `WindowServer`
/// after restoration.
fn report_focus_return(handed_back: bool, previous: Option<pid_t>) {
	let pid = |pid: pid_t| u32::try_from(pid).ok();
	control::report_focus_return(DesktopFocusReturn {
		handed_back,
		previous_pid: previous.and_then(pid),
		front_pid: front_pid().and_then(pid),
	});
}

/// Where focus sits when a takeover ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FocusAfterTakeover {
	/// The target process is front, whichever of its windows is key.
	Target,
	/// Another process is front: the user's own app again, or a third app.
	Elsewhere,
}

/// Whether a takeover hands focus back to the app the user was in.
///
/// An explicit takeover yields to any user input during the action, so a key
/// the user typed or a window they picked keeps focus where it went. Without
/// such input it hands focus back whichever of the target's windows is key:
/// a document the action opened or a sheet it closed is not the user's
/// choice. A returning takeover (the host's rerun of a refused background
/// action) hands focus back even after user input: input the user typed while
/// the target was front was meant for their own app. Neither overwrites a
/// process the user switched to, which is either their own app already or a
/// deliberately chosen third app.
const fn hands_focus_back(return_focus: bool, user_acted: bool, now: FocusAfterTakeover) -> bool {
	match now {
		FocusAfterTakeover::Elsewhere => false,
		FocusAfterTakeover::Target => return_focus || !user_acted,
	}
}

pub(super) fn require_front_window(pid: pid_t, wid: u32) -> CoreResult<()> {
	control::check()?;
	if is_front_window(pid, wid) {
		Ok(())
	} else {
		Err(DesktopError::input_failed(format!(
			"takeover window {wid} lost exact keyboard focus; stopped input, which may be partial; \
			 inspect the target before retrying"
		)))
	}
}

pub(super) fn is_front_window(pid: pid_t, wid: u32) -> bool {
	FOREGROUND.as_ref().is_some_and(|spi| {
		front_process(spi.get_front).is_some_and(|front| front.pid == Some(pid))
			&& ax::focused_window_id(pid) == Some(wid)
	})
}

/// Read-only focus identity used to verify non-activating Space operations.
pub(super) fn front_window_context() -> Option<(pid_t, u32)> {
	let spi = FOREGROUND.as_ref()?;
	let pid = front_process(spi.get_front)?.pid?;
	Some((pid, ax::key_window_id(pid)?))
}

/// The front process's pid as `WindowServer` reports it.
pub(in crate::desktop) fn front_pid() -> Option<pid_t> {
	front_process(FOREGROUND.as_ref()?.get_front)?.pid
}

type SLSWindowQueryWindowsFn = unsafe extern "C" fn(i32, &CFArray, u32) -> *mut CFType;
type SLSWindowQueryResultCopyWindowsFn = unsafe extern "C" fn(&CFType) -> *mut CFType;
type SLSWindowIteratorAdvanceFn = unsafe extern "C" fn(&CFType) -> bool;
type SLSWindowIteratorGetIdFn = unsafe extern "C" fn(&CFType) -> u32;

#[derive(Clone, Copy)]
struct WindowQuerySpi {
	connection: CGSMainConnectionIDFn,
	query:      SLSWindowQueryWindowsFn,
	windows:    SLSWindowQueryResultCopyWindowsFn,
	advance:    SLSWindowIteratorAdvanceFn,
	window_id:  SLSWindowIteratorGetIdFn,
	parent_id:  SLSWindowIteratorGetIdFn,
}

static WINDOW_QUERY: LazyLock<Option<WindowQuerySpi>> = LazyLock::new(|| {
	route::load_skylight()?;
	Some(WindowQuerySpi {
		connection: symbol(c"CGSMainConnectionID")?,
		query:      symbol(c"SLSWindowQueryWindows")?,
		windows:    symbol(c"SLSWindowQueryResultCopyWindows")?,
		advance:    symbol(c"SLSWindowIteratorAdvance")?,
		window_id:  symbol(c"SLSWindowIteratorGetWindowID")?,
		parent_id:  symbol(c"SLSWindowIteratorGetParentID")?,
	})
});

/// The window `wid` is a child of in `WindowServer`, such as the window a
/// sheet or an inline editor's overlay is attached to; `None` for a top-level
/// window or when the query is unavailable.
pub(super) fn window_parent(wid: u32) -> Option<u32> {
	let spi = WINDOW_QUERY.as_ref()?;
	let number = CFNumber::new_i64(i64::from(wid));
	let windows = CFArray::from_objects(&[&*number]);
	// SAFETY: The no-argument connection query has its exact signature.
	let connection = unsafe { (spi.connection)() } as i32;
	// SAFETY: `windows` holds one CFNumber window id and outlives the call; the
	// result is a create-rule object or null.
	let query = retained(unsafe { (spi.query)(connection, windows.as_opaque(), 0) })?;
	// SAFETY: `query` is a live window query; the result is create-rule or null.
	let iterator = retained(unsafe { (spi.windows)(&query) })?;
	// SAFETY: `iterator` stays retained across every iterator call.
	while unsafe { (spi.advance)(&iterator) } {
		// SAFETY: As above; the iterator was advanced onto a window.
		if unsafe { (spi.window_id)(&iterator) } == wid {
			// SAFETY: As above.
			return Some(unsafe { (spi.parent_id)(&iterator) }).filter(|&parent| parent != 0);
		}
	}
	None
}

type SLSConnectionGetPIDFn = unsafe extern "C" fn(u32, *mut pid_t) -> i32;

#[derive(Clone, Copy)]
struct WindowOwnerSpi {
	connection: CGSMainConnectionIDFn,
	owner:      SLSGetWindowOwnerFn,
	pid:        SLSConnectionGetPIDFn,
}

static WINDOW_OWNER: LazyLock<Option<WindowOwnerSpi>> = LazyLock::new(|| {
	route::load_skylight()?;
	Some(WindowOwnerSpi {
		connection: symbol(c"CGSMainConnectionID")?,
		owner:      symbol(c"SLSGetWindowOwner")?,
		pid:        symbol(c"SLSConnectionGetPID")?,
	})
});

/// The process that owns window `wid` in `WindowServer`, including the
/// windows a remote-view service keeps off the window list, such as the one
/// `openAndSavePanelService` draws an application's Open panel in.
pub(super) fn window_owner_pid(wid: u32) -> Option<pid_t> {
	let spi = WINDOW_OWNER.as_ref()?;
	let mut owner = 0u32;
	// SAFETY: The connection query takes no arguments, and `owner` is writable
	// for the exact window-owner signature.
	if unsafe { (spi.owner)((spi.connection)(), wid, &mut owner) } != 0 || owner == 0 {
		return None;
	}
	let mut pid: pid_t = 0;
	// SAFETY: `pid` is writable for the exact connection-pid signature.
	(unsafe { (spi.pid)(owner, &mut pid) } == 0 && pid > 0).then_some(pid)
}

/// Takes ownership of a create-rule `CFType` pointer, which may be null.
fn retained(pointer: *mut CFType) -> Option<CFRetained<CFType>> {
	// SAFETY: Every caller passes the +1 result of a copy or create call.
	ptr::NonNull::new(pointer).map(|pointer| unsafe { CFRetained::from_raw(pointer) })
}

/// Whether the target already is the key window of the front process.
fn preserves_exact_existing_focus(
	previous: Option<ProcessSerialNumber>,
	target: ProcessSerialNumber,
	focused: Option<u32>,
	wid: u32,
) -> bool {
	previous == Some(target) && focused == Some(wid)
}

/// Makes exactly `wid` the native key window of its front process without
/// raising it.
///
/// `AXFocusedWindow` can change without `AppKit` making the matching
/// `NSWindow` key, and menu validation and first-responder installation follow
/// the latter. This marks the front-process request as user generated and
/// posts the paired make-key records for the one window.
fn make_exact_window_key(
	spi: &ForegroundSpi,
	target: ProcessSerialNumber,
	wid: u32,
) -> CoreResult<()> {
	control::check()?;
	// SAFETY: Target PSN is valid and kCPSUserGenerated only changes how the
	// request is attributed.
	if unsafe { (spi.set_front)(&target, wid, CPS_USER_GENERATED) } != 0 {
		return Err(DesktopError::input_failed(format!(
			"window {wid} rejected exact key-window activation"
		)));
	}
	for kind in [0x01, 0x02] {
		if !post_record(spi.post_record, target, &make_key_record(wid, kind)) {
			return Err(DesktopError::input_failed(format!(
				"window {wid} rejected its make-key record"
			)));
		}
	}
	Ok(())
}

/// Waits until `wid` is its application's focused window.
///
/// Global HID input goes to whichever window is key, so a target that still
/// reports another focused window at the deadline refuses before any input is
/// sent. A front process alone is not proof of the exact key window. The
/// refusal names what held focus instead, so the caller can address it.
fn await_window_focused(
	spi: &ForegroundSpi,
	pid: pid_t,
	wid: u32,
	target: ProcessSerialNumber,
) -> CoreResult<()> {
	let deadline = Instant::now() + ACTIVATION_TIMEOUT;
	loop {
		let focused = ax::focused_window_id(pid);
		let front = front_process(spi.get_front);
		let target_front = front.is_some_and(|front| front.psn == target);
		if focused == Some(wid) && target_front {
			return Ok(());
		}
		if Instant::now() >= deadline {
			let seen = if target_front {
				KeyWindowSeen::Focused(ax::focused_window_label(pid))
			} else {
				let pid = front.and_then(|front| front.pid);
				KeyWindowSeen::Front { pid, name: pid.and_then(process::application_name) }
			};
			return Err(DesktopError::input_failed(unconfirmed_key_window(wid, &seen)));
		}
		control::wait(ACTIVATION_POLL)?;
	}
}

/// What held focus when a window could not be confirmed as the frontmost key
/// window.
#[derive(Debug, PartialEq, Eq)]
enum KeyWindowSeen {
	/// Another process stayed in front.
	Front { pid: Option<pid_t>, name: Option<String> },
	/// The target's process came to the front with this focused window, if any.
	Focused(Option<ax::WindowLabel>),
}

fn unconfirmed_key_window(wid: u32, seen: &KeyWindowSeen) -> String {
	let held = match seen {
		KeyWindowSeen::Front { pid: Some(pid), name: Some(name) } => {
			format!("{name} (pid {pid}) stayed the front application")
		},
		KeyWindowSeen::Front { pid: Some(pid), name: None } => {
			format!("pid {pid} stayed the front application")
		},
		KeyWindowSeen::Front { pid: None, .. } => {
			"the front application could not be identified".to_owned()
		},
		KeyWindowSeen::Focused(None) => "its application reports no focused window".to_owned(),
		KeyWindowSeen::Focused(Some(window)) => {
			let title = window.title.as_ref().map(|title| format!(" \"{title}\""));
			let kind = window.kind.as_ref().map(|kind| format!(" ({kind})"));
			let (title, kind) = (title.unwrap_or_default(), kind.unwrap_or_default());
			match window.id {
				Some(id) => format!("its application's focused window is window {id}{title}{kind}"),
				None => format!("its application's focused window{title}{kind} has no window id"),
			}
		},
	};
	format!("window {wid} could not be confirmed as the exact frontmost key window: {held}")
}

fn process_psn(lookup: PsnLookup, pid: pid_t, wid: u32) -> Option<ProcessSerialNumber> {
	if let (Some(main_connection), Some(get_window_owner), Some(get_connection_psn)) =
		(lookup.main_connection, lookup.get_window_owner, lookup.get_connection_psn)
	{
		// SAFETY: The no-argument connection query was resolved with its exact
		// signature.
		let main_connection = unsafe { main_connection() };
		let mut owner_connection = 0u32;
		// SAFETY: `owner_connection` is writable for the synchronous lookup.
		if unsafe { get_window_owner(main_connection, wid, &mut owner_connection) } == 0
			&& owner_connection != 0
		{
			let mut psn = ProcessSerialNumber::default();
			// SAFETY: `psn` is writable and has the exact 8-byte layout required
			// by the SPI.
			if unsafe { get_connection_psn(owner_connection, &mut psn) } == 0 {
				return Some(psn);
			}
		}
	}
	let fallback = lookup.get_process_for_pid?;
	let mut psn = ProcessSerialNumber::default();
	// SAFETY: `psn` is writable and `fallback` was resolved with the exact
	// GetProcessForPID ABI.
	if unsafe { fallback(pid, &mut psn) } == 0 {
		Some(psn)
	} else {
		None
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::desktop::error::ErrorCode;

	#[test]
	fn user_focus_changes_permanently_disarm_background_restoration() {
		let previous = ProcessSerialNumber { high: 0, low: 7 };
		let target = ProcessSerialNumber { high: 0, low: 8 };
		let third = ProcessSerialNumber { high: 0, low: 9 };
		let lease = || BackgroundFocusLease {
			previous,
			target,
			key: Some(42),
			activity: [0; 5],
			disarmed: false,
		};
		let mut guard = lease();
		assert_eq!(guard.observe(target, None, [0; 5]), FocusDecision::Restore);
		assert_eq!(guard.observe(third, None, [0; 5]), FocusDecision::Disarm);
		assert_eq!(guard.observe(target, None, [0; 5]), FocusDecision::Disarm);

		let mut guard = lease();
		assert_eq!(guard.observe(previous, Some(43), [0; 5]), FocusDecision::Disarm);
		assert_eq!(guard.observe(target, None, [0; 5]), FocusDecision::Disarm);

		let mut guard = lease();
		assert_eq!(guard.observe(target, None, [1; 5]), FocusDecision::Disarm);
	}

	#[test]
	fn typing_in_the_original_window_does_not_claim_a_user_focus_switch() {
		let previous = ProcessSerialNumber { high: 0, low: 7 };
		let target = ProcessSerialNumber { high: 0, low: 8 };
		let mut guard = BackgroundFocusLease {
			previous,
			target,
			key: Some(42),
			activity: [0; 5],
			disarmed: false,
		};
		assert_eq!(guard.observe(previous, Some(42), [1; 5]), FocusDecision::Observe);
		assert_eq!(guard.observe(target, None, [1; 5]), FocusDecision::Restore);
	}

	#[test]
	fn a_window_appearing_in_a_windowless_front_app_is_a_user_focus_change() {
		// Finder in front after a click on the desktop: no key window to restore.
		let previous = ProcessSerialNumber { high: 0, low: 7 };
		let target = ProcessSerialNumber { high: 0, low: 8 };
		let lease =
			|| BackgroundFocusLease { previous, target, key: None, activity: [0; 5], disarmed: false };
		let mut guard = lease();
		assert_eq!(guard.observe(previous, None, [0; 5]), FocusDecision::Observe);
		assert_eq!(guard.observe(target, None, [0; 5]), FocusDecision::Restore);

		// The user opened a Finder window meanwhile: hands off.
		let mut guard = lease();
		assert_eq!(guard.observe(previous, Some(43), [0; 5]), FocusDecision::Disarm);
		assert_eq!(guard.observe(target, None, [0; 5]), FocusDecision::Disarm);
	}

	#[test]
	fn only_a_provably_windowless_front_app_is_restored_without_a_key_window() {
		let unread = || -> Option<bool> { panic!("a known key window needs no window scan") };
		assert_eq!(restorable_key(Some(42), unread, unread), Some(UserKey::Window(42)));
		// TextEdit after closing its last document; Finder after a desktop click
		// lists only its unmappable desktop, which counts as no window.
		assert_eq!(restorable_key(None, || Some(false), || Some(false)), Some(UserKey::Windowless));
		// Windows that AX or WindowServer reports, or an unreadable answer,
		// refuse.
		assert_eq!(restorable_key(None, || Some(true), || Some(false)), None);
		assert_eq!(restorable_key(None, || Some(false), || Some(true)), None);
		assert_eq!(restorable_key(None, || None, || Some(false)), None);
		assert_eq!(restorable_key(None, || Some(false), || None), None);
	}

	#[test]
	fn a_failed_action_still_settles_under_the_guard() {
		// AXOpen in Chrome's Open panel fails with -25205, then Chrome comes
		// forward: the guard must still be watching.
		let mut settled = false;
		let result: CoreResult<()> = run_then_settle(
			|| Err(DesktopError::ax_failed("AX action 'AXOpen' failed (AXError(-25205))")),
			|| {
				settled = true;
				Err(DesktopError::cancelled("stopped"))
			},
		);
		assert!(settled);
		let error = result.expect_err("the action failed");
		assert_eq!(
			(error.code, error.message.as_str()),
			(ErrorCode::AxFailed, "AX action 'AXOpen' failed (AXError(-25205))")
		);

		let result = run_then_settle(|| Ok(7), || Err(DesktopError::cancelled("stopped")));
		assert_eq!(result.expect_err("the settle was cancelled").code, ErrorCode::Cancelled);
		assert_eq!(run_then_settle(|| Ok(7), || Ok(())).ok(), Some(7));
	}

	#[test]
	fn only_the_exact_key_window_of_the_front_process_skips_activation() {
		let target = ProcessSerialNumber { high: 0, low: 7 };
		let other = ProcessSerialNumber { high: 0, low: 8 };
		assert!(preserves_exact_existing_focus(Some(target), target, Some(42), 42));
		assert!(!preserves_exact_existing_focus(Some(other), target, Some(42), 42));
		assert!(!preserves_exact_existing_focus(Some(target), target, Some(41), 42));
		assert!(!preserves_exact_existing_focus(Some(target), target, None, 42));
		assert!(!preserves_exact_existing_focus(None, target, Some(42), 42));
	}

	#[test]
	fn the_hand_back_timestamp_precedes_the_last_check() {
		use std::cell::RefCell;
		let steps = RefCell::new(Vec::new());
		let handed = request_after_check(
			|| {
				steps.borrow_mut().push("clock");
				7
			},
			|| {
				steps.borrow_mut().push("check");
				true
			},
			|since| {
				steps.borrow_mut().push("request");
				assert_eq!(since, 7, "the request carries the timestamp taken before the check");
				Ok(FrontRequest::UserActed)
			},
		);
		assert_eq!(handed.ok(), Some(Some(FrontRequest::UserActed)));
		assert_eq!(*steps.borrow(), ["clock", "check", "request"]);

		let unwanted =
			request_after_check(|| 7, || false, |_| panic!("no request once the check fails"));
		assert_eq!(unwanted.ok(), Some(None));
	}

	#[test]
	fn takeover_hands_back_through_the_users_typing_but_not_their_click() {
		use std::cell::Cell;
		// The monitor saw the user type after each refused timestamp, and
		// nothing else changed: a fresh timestamp is asked for until it goes
		// through.
		let clock = Cell::new(0);
		let stamps = std::cell::RefCell::new(Vec::new());
		let handed = hand_back_through_typing(
			|| {
				clock.set(clock.get() + 1);
				clock.get()
			},
			|| true,
			|since| since <= 1,
			|since| {
				stamps.borrow_mut().push(since);
				Ok(if since < 2 {
					FrontRequest::UserActed
				} else {
					FrontRequest::Done
				})
			},
		);
		assert_eq!(handed.ok(), Some(Some(FrontRequest::Done)));
		assert_eq!(*stamps.borrow(), [1, 2]);

		// A click after the refusal: the target stays the user's.
		let clicked = Cell::new(false);
		let requests = Cell::new(0);
		let handed = hand_back_through_typing(
			|| 1,
			|| !clicked.get(),
			|_| true,
			|_| {
				requests.set(requests.get() + 1);
				clicked.set(true);
				Ok(FrontRequest::UserActed)
			},
		);
		assert_eq!(handed.ok(), Some(None));
		assert_eq!(requests.get(), 1);

		// A refusal the monitor has seen no typing for (a click or shortcut it
		// has not counted yet, or no monitor at all) stands after one request.
		let requests = Cell::new(0);
		let handed = hand_back_through_typing(
			|| 5,
			|| true,
			|_| false,
			|_| {
				requests.set(requests.get() + 1);
				Ok(FrontRequest::UserActed)
			},
		);
		assert_eq!(handed.ok(), Some(Some(FrontRequest::UserActed)));
		assert_eq!(requests.get(), 1);

		// Typing never pauses: a bounded number of requests, then it gives up.
		let requests = Cell::new(0);
		let handed = hand_back_through_typing(
			|| 1,
			|| true,
			|_| true,
			|_| {
				requests.set(requests.get() + 1);
				Ok(FrontRequest::UserActed)
			},
		);
		assert_eq!(handed.ok(), Some(Some(FrontRequest::UserActed)));
		assert_eq!(requests.get(), TAKEOVER_HAND_BACK_TRIES);
	}

	#[test]
	fn a_front_request_the_user_overtook_is_their_choice_not_an_error() {
		assert_eq!(front_request(0).ok(), Some(FrontRequest::Done));
		assert_eq!(front_request(EXPIRED_FRONT_REQUEST).ok(), Some(FrontRequest::UserActed));
		assert_eq!(
			front_request(-1)
				.expect_err("other failures stay errors")
				.code,
			ErrorCode::InputFailed
		);
	}

	#[test]
	fn an_unconfirmed_key_window_names_what_held_focus_instead() {
		let focused = |id, title: Option<&str>, kind: &str| {
			KeyWindowSeen::Focused(Some(ax::WindowLabel {
				id,
				title: title.map(str::to_owned),
				kind: Some(kind.to_owned()),
			}))
		};
		let refusal = |wid, seen| unconfirmed_key_window(wid, &seen);
		let prefix = "could not be confirmed as the exact frontmost key window: ";
		// Calendar's untitled recurring-event alert held key over its window 66.
		assert_eq!(
			refusal(66, focused(Some(93), None, "AXDialog")),
			format!("window 66 {prefix}its application's focused window is window 93 (AXDialog)")
		);
		assert_eq!(
			refusal(186, focused(Some(191), Some("Go to Folder"), "AXSheet")),
			format!(
				"window 186 {prefix}its application's focused window is window 191 \"Go to Folder\" \
				 (AXSheet)"
			)
		);
		assert_eq!(
			refusal(186, focused(None, Some("Open"), "AXSheet")),
			format!(
				"window 186 {prefix}its application's focused window \"Open\" (AXSheet) has no window \
				 id"
			)
		);
		assert_eq!(
			refusal(66, KeyWindowSeen::Focused(None)),
			format!("window 66 {prefix}its application reports no focused window")
		);
		assert_eq!(
			refusal(66, KeyWindowSeen::Front { pid: Some(367), name: Some("iTerm2".to_owned()) }),
			format!("window 66 {prefix}iTerm2 (pid 367) stayed the front application")
		);
		assert_eq!(
			refusal(66, KeyWindowSeen::Front { pid: Some(367), name: None }),
			format!("window 66 {prefix}pid 367 stayed the front application")
		);
		assert_eq!(
			refusal(66, KeyWindowSeen::Front { pid: None, name: None }),
			format!("window 66 {prefix}the front application could not be identified")
		);
	}

	#[test]
	fn a_returning_takeover_hands_focus_back_after_typing_but_not_over_a_third_app() {
		use FocusAfterTakeover::{Elsewhere, Target};
		// The user typed (or clicked) while the target was front: a returning
		// takeover still hands focus back, an explicit one yields to that input.
		assert!(hands_focus_back(true, true, Target));
		assert!(!hands_focus_back(false, true, Target));
		// With no user input both hand focus back, whichever of the target's
		// windows the action left key (a document it opened, a sheet it closed).
		assert!(hands_focus_back(true, false, Target));
		assert!(hands_focus_back(false, false, Target));
		// A process the user switched to keeps focus either way.
		for (return_focus, user_acted) in [(true, true), (true, false), (false, false)] {
			assert!(!hands_focus_back(return_focus, user_acted, Elsewhere));
		}
	}
}
