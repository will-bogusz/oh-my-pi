//! Listen-only event taps: physical Escape for operation and durable task
//! ownership, and the user's own keys and clicks in the apps a session uses.
use std::{
	ffi::c_void,
	ptr,
	sync::Arc,
	thread::{self, JoinHandle},
	time::Instant,
};

use parking_lot::Mutex;

use super::{CoreResult, DesktopError, EmergencyStop, intervention::UserInputs};
use crate::desktop::macos::front_pid;

pub(crate) const SYNTHETIC_EVENT_TAG: i64 = 0x7069_6465_736b;
const SOURCE_USER_DATA: u32 = 42;
const SOURCE_UNIX_PID: u32 = 41;
/// `kCGEventTargetUnixProcessID`: the process `WindowServer` routes the event
/// to, filled in at the annotated session tap (to be confirmed live for keys
/// and clicks).
const TARGET_UNIX_PID: u32 = 40;
const KEYBOARD_KEYCODE: u32 = 9;
const LEFT_MOUSE_DOWN: u32 = 1;
const RIGHT_MOUSE_DOWN: u32 = 3;
const KEY_DOWN: u32 = 10;
const OTHER_MOUSE_DOWN: u32 = 25;
const SESSION_TAP: u32 = 1;
const ANNOTATED_SESSION_TAP: u32 = 2;
type Ref = *mut c_void;
type ConstRef = *const c_void;
type Callback = unsafe extern "C" fn(Ref, u32, Ref, Ref) -> Ref;

#[repr(C)]
struct SourceContext {
	version:     isize,
	info:        Ref,
	retain:      Option<unsafe extern "C" fn(ConstRef) -> ConstRef>,
	release:     Option<unsafe extern "C" fn(ConstRef)>,
	description: Option<unsafe extern "C" fn(ConstRef) -> ConstRef>,
	equal:       Option<unsafe extern "C" fn(ConstRef, ConstRef) -> bool>,
	hash:        Option<unsafe extern "C" fn(ConstRef) -> usize>,
	schedule:    Option<unsafe extern "C" fn(Ref, Ref, Ref)>,
	cancel:      Option<unsafe extern "C" fn(Ref, Ref, Ref)>,
	perform:     Option<unsafe extern "C" fn(Ref)>,
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
	fn CGEventTapCreate(
		tap: u32,
		place: u32,
		options: u32,
		mask: u64,
		callback: Callback,
		user: Ref,
	) -> Ref;
	fn CGEventGetIntegerValueField(event: Ref, field: u32) -> i64;
	fn CGEventGetFlags(event: Ref) -> u64;
	fn CGEventTapEnable(tap: Ref, enable: bool);
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
	static kCFRunLoopDefaultMode: Ref;
	fn CFMachPortCreateRunLoopSource(allocator: Ref, port: Ref, order: isize) -> Ref;
	fn CFMachPortInvalidate(port: Ref);
	fn CFRunLoopGetCurrent() -> ConstRef;
	fn CFRunLoopAddSource(run_loop: ConstRef, source: Ref, mode: Ref);
	fn CFRunLoopRemoveSource(run_loop: ConstRef, source: Ref, mode: Ref);
	fn CFRunLoopSourceCreate(allocator: Ref, order: isize, context: *mut SourceContext) -> Ref;
	fn CFRunLoopSourceSignal(source: Ref);
	fn CFRunLoopRun();
	fn CFRunLoopStop(run_loop: ConstRef);
	fn CFRunLoopWakeUp(run_loop: ConstRef);
	fn CFRetain(object: ConstRef) -> ConstRef;
	fn CFRelease(object: ConstRef);
}

struct TapContext<C> {
	inner: C,
	tap:   Ref,
}

/// The ports of this process's live taps, so the process can invalidate them
/// before it exits ([`close_taps`]).
struct LiveTaps(Mutex<Vec<usize>>);

static LIVE_TAPS: LiveTaps = LiveTaps(Mutex::new(Vec::new()));

impl LiveTaps {
	fn add(&self, port: Ref) {
		self.0.lock().push(port as usize);
	}

	/// Removes `port` and invalidates it under the same lock as
	/// [`Self::close`], so neither touches a port the other may release.
	///
	/// # Safety
	/// `port` must be a live `CFMachPort`.
	unsafe fn invalidate(&self, port: Ref) {
		let mut live = self.0.lock();
		live.retain(|&live| live != port as usize);
		// SAFETY: forwarded caller contract.
		unsafe { CFMachPortInvalidate(port) };
	}

	fn close(&self) {
		for port in self.0.lock().drain(..) {
			// SAFETY: a port is listed only while its tap thread holds it, and
			// that thread unlists it under this lock before releasing it.
			unsafe { CFMachPortInvalidate(port as Ref) };
		}
	}
}

/// Invalidates every listen-only tap this process still holds; for a process
/// about to exit, after which no tap here sees input again. A tap whose
/// process exits or is killed with it still valid makes `WindowServer`
/// deliver the key it was routing at that moment again to the app the user
/// types in, often many times; a tap invalidated first never did (measured on
/// macOS 26.5 with helper processes exiting during the user's typing). The
/// host calls this from its exit handler: Bun's `process.exit` runs no native
/// exit hook. Nothing helps a process killed outright.
pub(super) fn close_taps() {
	LIVE_TAPS.close();
}

const fn physical_escape(kind: u32, key: i64, pid: i64, tag: i64) -> bool {
	kind == KEY_DOWN && key == 53 && pid == 0 && tag != SYNTHETIC_EVENT_TAG
}

const FLAGS_CHANGED: u32 = 12;
const COMMAND_FLAG: u64 = 0x0010_0000;

/// What a physical event means for takeover's hand-back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UserInput {
	/// A mouse press or a Command shortcut (Command-Tab, Spotlight): it picks
	/// an app or window, so the hand-back stands down.
	Choice,
	/// Plain typing, which reaches the takeover target only because takeover
	/// holds the front.
	Typing,
}

const fn user_input(kind: u32, flags: u64, pid: i64, tag: i64) -> Option<UserInput> {
	if pid != 0 || tag == SYNTHETIC_EVENT_TAG {
		return None;
	}
	match kind {
		1 | 3 | 25 => Some(UserInput::Choice),
		KEY_DOWN if flags & COMMAND_FLAG != 0 => Some(UserInput::Choice),
		KEY_DOWN | FLAGS_CHANGED => Some(UserInput::Typing),
		_ => None,
	}
}

fn uptime_ns() -> u64 {
	let mut time = libc::timespec { tv_sec: 0, tv_nsec: 0 };
	// SAFETY: `time` is writable for the call, which retains no pointer.
	unsafe { libc::clock_gettime(libc::CLOCK_UPTIME_RAW, &raw mut time) };
	u64::try_from(time.tv_sec).unwrap_or(0) * 1_000_000_000
		+ u64::try_from(time.tv_nsec).unwrap_or(0)
}

unsafe extern "C" fn observe(_proxy: Ref, kind: u32, event: Ref, user: Ref) -> Ref {
	// SAFETY: the monitor thread retains this stack context through
	// invalidation.
	let context = unsafe { &*(user.cast::<TapContext<EmergencyStop>>()) };
	if kind == u32::MAX || kind == u32::MAX - 1 {
		context.inner.cancel();
		// SAFETY: the event tap remains alive until this callback returns.
		unsafe {
			CGEventTapEnable(context.tap, true);
		}
		return event;
	}
	if !event.is_null() {
		// SAFETY: documented read-only CGEvent fields.
		let (key, pid, tag, flags) = unsafe {
			(
				CGEventGetIntegerValueField(event, KEYBOARD_KEYCODE),
				CGEventGetIntegerValueField(event, SOURCE_UNIX_PID),
				CGEventGetIntegerValueField(event, SOURCE_USER_DATA),
				CGEventGetFlags(event),
			)
		};
		match user_input(kind, flags, pid, tag) {
			Some(UserInput::Choice) => {
				super::USER_CHOICES.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
			},
			Some(UserInput::Typing) => {
				super::LAST_USER_TYPING.store(uptime_ns(), std::sync::atomic::Ordering::Release);
			},
			None => {},
		}
		if physical_escape(kind, key, pid, tag) {
			context.inner.escape();
		}
	}
	event
}

/// Whether an event came from someone other than this process: the user's
/// hardware, or a tool such as dictation that posts for them under its own
/// process id.
const fn foreign(tag: i64, source_pid: i64, own_pid: i64) -> bool {
	tag != SYNTHETIC_EVENT_TAG && source_pid != own_pid
}

/// The process a foreign key press or click lands in: the target the
/// annotated tap names, else for a key the front process, which takes the
/// keyboard. A click without a target names no app and is dropped.
fn input_target(
	kind: u32,
	target: i64,
	front: impl FnOnce() -> Option<libc::pid_t>,
) -> Option<libc::pid_t> {
	match libc::pid_t::try_from(target) {
		Ok(pid) if pid > 0 => Some(pid),
		_ if kind == KEY_DOWN => front(),
		_ => None,
	}
}

unsafe extern "C" fn observe_user(_proxy: Ref, kind: u32, event: Ref, user: Ref) -> Ref {
	// SAFETY: the monitor thread retains this stack context through
	// invalidation.
	let context = unsafe { &*(user.cast::<TapContext<Arc<UserInputs>>>()) };
	if kind == u32::MAX || kind == u32::MAX - 1 {
		// SAFETY: the event tap remains alive until this callback returns.
		unsafe {
			CGEventTapEnable(context.tap, true);
		}
		return event;
	}
	if !event.is_null() {
		// SAFETY: documented read-only CGEvent fields.
		let (tag, source, target) = unsafe {
			(
				CGEventGetIntegerValueField(event, SOURCE_USER_DATA),
				CGEventGetIntegerValueField(event, SOURCE_UNIX_PID),
				CGEventGetIntegerValueField(event, TARGET_UNIX_PID),
			)
		};
		if foreign(tag, source, i64::from(std::process::id()))
			&& let Some(pid) = input_target(kind, target, front_pid)
		{
			context.inner.record(pid, Instant::now());
		}
	}
	event
}

unsafe extern "C" fn stop_loop(_: Ref) {
	// SAFETY: this callback runs on the monitor's own run loop.
	unsafe {
		CFRunLoopStop(CFRunLoopGetCurrent());
	}
}

/// A listen-only event tap running on its own thread's run loop until drop.
struct TapThread {
	thread:      Option<JoinHandle<()>>,
	run_loop:    usize,
	stop_source: usize,
}

impl TapThread {
	fn start<C: Send + 'static>(
		thread_name: &'static str,
		label: &'static str,
		location: u32,
		mask: u64,
		inner: C,
		callback: Callback,
	) -> CoreResult<Self> {
		let (ready, receive) = flume::bounded(1);
		let worker = thread::Builder::new()
			.name(thread_name.into())
			.spawn(move || {
				let mut context = TapContext { inner, tap: ptr::null_mut() };
				// SAFETY: listen-only tap; context stays live until invalidation.
				let tap = unsafe {
					CGEventTapCreate(location, 0, 1, mask, callback, ptr::from_mut(&mut context).cast())
				};
				if tap.is_null() {
					let _ = ready.send(None);
					return;
				}
				context.tap = tap;
				let mut stop_context = SourceContext {
					version:     0,
					info:        ptr::null_mut(),
					retain:      None,
					release:     None,
					description: None,
					equal:       None,
					hash:        None,
					schedule:    None,
					cancel:      None,
					perform:     Some(stop_loop),
				};
				// SAFETY: valid create-rule tap and version-zero run-loop context.
				let (source, stop_source) = unsafe {
					(
						CFMachPortCreateRunLoopSource(ptr::null_mut(), tap, 0),
						CFRunLoopSourceCreate(ptr::null_mut(), -1, &raw mut stop_context),
					)
				};
				if source.is_null() || stop_source.is_null() {
					// SAFETY: release exactly the objects successfully created
					// above.
					unsafe {
						if !source.is_null() {
							CFRelease(source);
						}
						if !stop_source.is_null() {
							CFRelease(stop_source);
						}
						CFMachPortInvalidate(tap);
						CFRelease(tap);
					}
					let _ = ready.send(None);
					return;
				}
				// SAFETY: all sources remain retained throughout the loop; the
				// owner gets separate retains for its signal/wakeup
				// request.
				unsafe {
					let run_loop = CFRunLoopGetCurrent();
					CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);
					CFRunLoopAddSource(run_loop, stop_source, kCFRunLoopDefaultMode);
					CGEventTapEnable(tap, true);
					LIVE_TAPS.add(tap);
					let _ =
						ready.send(Some((CFRetain(run_loop) as usize, CFRetain(stop_source) as usize)));
					CFRunLoopRun();
					CFRunLoopRemoveSource(run_loop, source, kCFRunLoopDefaultMode);
					CFRunLoopRemoveSource(run_loop, stop_source, kCFRunLoopDefaultMode);
					LIVE_TAPS.invalidate(tap);
					CFRelease(source);
					CFRelease(stop_source);
					CFRelease(tap);
				}
			})
			.map_err(|error| {
				DesktopError::input_failed(format!("cannot start {label} monitor: {error}"))
			})?;
		let Some((run_loop, stop_source)) = receive.recv().ok().flatten() else {
			let _ = worker.join();
			return Err(DesktopError::permission_denied(format!(
				"cannot monitor {label}; macOS Accessibility/Input Monitoring permission is required \
				 before input"
			)));
		};
		Ok(Self { thread: Some(worker), run_loop, stop_source })
	}
}

impl Drop for TapThread {
	fn drop(&mut self) {
		// SAFETY: these retains belong to this owner. A signaled source remains
		// pending even when stop races the first CFRunLoopRun call.
		unsafe {
			CFRunLoopSourceSignal(self.stop_source as Ref);
			CFRunLoopWakeUp(self.run_loop as ConstRef);
			CFRelease(self.stop_source as ConstRef);
			CFRelease(self.run_loop as ConstRef);
		}
		if let Some(worker) = self.thread.take()
			&& worker.thread().id() != thread::current().id()
		{
			let _ = worker.join();
		}
	}
}

pub(super) struct EscapeMonitor {
	_tap: TapThread,
}

impl EscapeMonitor {
	pub(super) fn start(emergency: EmergencyStop) -> CoreResult<Self> {
		let tap = TapThread::start(
			"desktop-escape",
			"emergency Escape",
			SESSION_TAP,
			(1 << KEY_DOWN) | (1 << 1) | (1 << 3) | (1 << 25) | (1 << 12),
			emergency,
			observe,
		)?;
		Ok(Self { _tap: tap })
	}
}

/// Records every foreign key press and click by the process it lands in, at
/// the annotated session tap where `WindowServer` has named that process. It
/// listens during background input and between calls, not only during
/// takeover like the Escape monitor.
pub(super) struct UserInputMonitor {
	_tap: TapThread,
}

impl UserInputMonitor {
	pub(super) fn start(inputs: Arc<UserInputs>) -> CoreResult<Self> {
		let tap = TapThread::start(
			"desktop-user-input",
			"user input",
			ANNOTATED_SESSION_TAP,
			(1 << KEY_DOWN)
				| (1 << LEFT_MOUSE_DOWN)
				| (1 << RIGHT_MOUSE_DOWN)
				| (1 << OTHER_MOUSE_DOWN),
			inputs,
			observe_user,
		)?;
		Ok(Self { _tap: tap })
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// `CFMachPortContext`, version 0.
	#[repr(C)]
	struct PortContext {
		version:     isize,
		info:        Ref,
		retain:      Option<unsafe extern "C" fn(ConstRef) -> ConstRef>,
		release:     Option<unsafe extern "C" fn(ConstRef)>,
		description: Option<unsafe extern "C" fn(ConstRef) -> ConstRef>,
	}

	#[link(name = "CoreFoundation", kind = "framework")]
	unsafe extern "C" {
		fn CFMachPortCreate(
			allocator: Ref,
			callback: unsafe extern "C" fn(Ref, Ref, isize, Ref),
			context: *mut PortContext,
			should_free_info: *mut bool,
		) -> Ref;
		fn CFMachPortIsValid(port: Ref) -> bool;
	}

	unsafe extern "C" fn ignore(_: Ref, _: Ref, _: isize, _: Ref) {}

	/// A plain mach port standing in for a tap's, which needs event-listening
	/// access to create.
	fn port() -> Ref {
		let mut context = PortContext {
			version:     0,
			info:        ptr::null_mut(),
			retain:      None,
			release:     None,
			description: None,
		};
		// SAFETY: a version-zero context copied at creation and a no-op
		// callback.
		let port =
			unsafe { CFMachPortCreate(ptr::null_mut(), ignore, &raw mut context, ptr::null_mut()) };
		assert!(!port.is_null());
		port
	}

	#[test]
	fn closing_invalidates_every_live_tap_and_none_its_thread_already_ended() {
		let taps = LiveTaps(Mutex::new(Vec::new()));
		let (live, ended) = (port(), port());
		taps.add(live);
		taps.add(ended);
		// SAFETY: `ended` is a live port, released below.
		unsafe { taps.invalidate(ended) };
		let other = port();
		taps.close();
		// SAFETY: live ports created above.
		unsafe {
			assert!(!CFMachPortIsValid(live), "a live tap outlived close");
			assert!(!CFMachPortIsValid(ended));
			assert!(CFMachPortIsValid(other), "close touched a port it was never given");
		}
		assert!(taps.0.lock().is_empty());
		// A tap thread ending after close finds its port already gone.
		// SAFETY: still a live (invalid) CFMachPort.
		unsafe { taps.invalidate(live) };
		// SAFETY: create-rule objects from `port`.
		unsafe {
			for port in [live, ended, other] {
				CFRelease(port);
			}
		}
	}

	#[test]
	fn only_physical_escape_cancels() {
		assert!(physical_escape(KEY_DOWN, 53, 0, 0));
		assert!(!physical_escape(KEY_DOWN, 53, 0, SYNTHETIC_EVENT_TAG));
		assert!(!physical_escape(KEY_DOWN, 53, 42, 0));
		assert!(!physical_escape(KEY_DOWN, 0, 0, 0));
		assert!(!physical_escape(11, 53, 0, 0));
	}

	#[test]
	fn the_users_and_their_tools_input_is_foreign_and_this_processs_is_not() {
		let own = 900;
		// Hardware input carries no source process.
		assert!(foreign(0, 0, own));
		// A dictation tool posts under its own process id.
		assert!(foreign(0, 4242, own));
		// Anything this process posts carries its tag, whoever relays it.
		assert!(!foreign(SYNTHETIC_EVENT_TAG, 0, own));
		assert!(!foreign(SYNTHETIC_EVENT_TAG, 4242, own));
		// An untagged event this process posted is still its own.
		assert!(!foreign(0, own, own));
	}

	#[test]
	fn foreign_input_lands_in_its_annotated_target_or_a_key_in_the_front_process() {
		let unread = || -> Option<libc::pid_t> { panic!("the front process is not read") };
		assert_eq!(input_target(KEY_DOWN, 77, unread), Some(77));
		assert_eq!(input_target(LEFT_MOUSE_DOWN, 77, unread), Some(77));
		assert_eq!(input_target(KEY_DOWN, 0, || Some(12)), Some(12));
		assert_eq!(input_target(KEY_DOWN, 0, || None), None);
		assert_eq!(input_target(LEFT_MOUSE_DOWN, 0, unread), None);
		assert_eq!(input_target(RIGHT_MOUSE_DOWN, -1, unread), None);
	}

	#[test]
	fn clicks_and_command_shortcuts_choose_while_plain_typing_does_not() {
		for kind in [1, 3, 25] {
			assert_eq!(user_input(kind, 0, 0, 0), Some(UserInput::Choice));
			assert_eq!(user_input(kind, 0, 0, SYNTHETIC_EVENT_TAG), None);
			assert_eq!(user_input(kind, 0, 42, 0), None);
		}
		// Command-Tab and Command-Space pick an app; Shift-typing does not.
		assert_eq!(user_input(KEY_DOWN, COMMAND_FLAG, 0, 0), Some(UserInput::Choice));
		assert_eq!(user_input(KEY_DOWN, COMMAND_FLAG | 0x2_0000, 0, 0), Some(UserInput::Choice));
		assert_eq!(user_input(KEY_DOWN, 0x2_0000, 0, 0), Some(UserInput::Typing));
		assert_eq!(user_input(KEY_DOWN, 0, 0, 0), Some(UserInput::Typing));
		assert_eq!(user_input(FLAGS_CHANGED, 0x2_0000, 0, 0), Some(UserInput::Typing));
		// omp's own keys and those another process posts are not the user's.
		assert_eq!(user_input(KEY_DOWN, COMMAND_FLAG, 0, SYNTHETIC_EVENT_TAG), None);
		assert_eq!(user_input(KEY_DOWN, 0, 42, 0), None);
		// Releases mean nothing on their own.
		for kind in [11, 2, 4, 26] {
			assert_eq!(user_input(kind, COMMAND_FLAG, 0, 0), None);
		}
	}
}
