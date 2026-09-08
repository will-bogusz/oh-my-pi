use std::{
	ffi::{CStr, c_void},
	mem,
	sync::LazyLock,
	thread,
	time::Duration,
};

use core_graphics::{event::CGEvent, geometry::CGPoint};
use foreign_types::ForeignType;
use libc::pid_t;
use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};

use super::super::error::{CoreResult, DesktopError};

const EVENT_RECORD_LENGTH: usize = 248;
const EVENT_RECORD_LENGTH_BYTE: u8 = 0xf8;
const EVENT_RECORD_KIND: u8 = 0x0d;
const WINDOW_ID_OFFSET: usize = 0x3c;
const FOCUS_MARKER_OFFSET: usize = 0x8a;

#[repr(C)]
#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct ProcessSerialNumber {
	high: u32,
	low:  u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct BackgroundActivation {
	target: ProcessSerialNumber,
	pid:    pid_t,
}

impl BackgroundActivation {
	pub(super) fn release(self) {
		// Never deactivate an application the user has since brought foreground.
		// Address the original WindowServer PSN, not a potentially reused PID.
		let front = NSWorkspace::sharedWorkspace().frontmostApplication();
		if front.is_none_or(|app| app.processIdentifier() == self.pid) {
			return;
		}
		let Ok(spi) = required() else { return };
		let mut record = [0u8; EVENT_RECORD_LENGTH];
		record[0x04] = EVENT_RECORD_LENGTH_BYTE;
		record[0x08] = EVENT_RECORD_KIND;
		record[FOCUS_MARKER_OFFSET] = 0x02;
		// SAFETY: The retained process identity and complete record remain live
		// through this synchronous call. A departed process's PSN is not retargeted.
		let _ = unsafe { (spi.post_record)(&self.target, record.as_ptr()) };
	}
}

type SLEventPostToPidFn = unsafe extern "C" fn(pid_t, *mut c_void);
type SLEventSetIntegerValueFieldFn = unsafe extern "C" fn(*mut c_void, u32, i64);
type SLPSPostEventRecordToFn = unsafe extern "C" fn(*const ProcessSerialNumber, *const u8) -> i32;
type SLPSGetFrontProcessFn = unsafe extern "C" fn(*mut ProcessSerialNumber) -> i32;
type CGSMainConnectionIDFn = unsafe extern "C" fn() -> u32;
type SLSGetWindowOwnerFn = unsafe extern "C" fn(u32, u32, *mut u32) -> i32;
type SLSGetConnectionPSNFn = unsafe extern "C" fn(u32, *mut ProcessSerialNumber) -> i32;
type GetProcessForPIDFn = unsafe extern "C" fn(pid_t, *mut ProcessSerialNumber) -> i32;
type CGEventSetWindowLocationFn = unsafe extern "C" fn(*mut c_void, CGPoint);
type SLPSSetFrontProcessWithOptionsFn =
	unsafe extern "C" fn(*const ProcessSerialNumber, u32, u32) -> i32;

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
	post_to_pid:         SLEventPostToPidFn,
	set_integer:         SLEventSetIntegerValueFieldFn,
	post_record:         SLPSPostEventRecordToFn,
	set_window_location: CGEventSetWindowLocationFn,
	psn:                 PsnLookup,
}

#[derive(Clone, Copy)]
struct ForegroundSpi {
	set_front: SLPSSetFrontProcessWithOptionsFn,
	get_front: SLPSGetFrontProcessFn,
	psn:       PsnLookup,
}

static REQUIRED: LazyLock<Option<RequiredSpi>> = LazyLock::new(resolve_required);
static FOREGROUND: LazyLock<Option<ForegroundSpi>> = LazyLock::new(resolve_foreground);

pub(super) fn is_available() -> bool {
	required().is_ok()
}

fn required() -> CoreResult<&'static RequiredSpi> {
	REQUIRED.as_ref().ok_or_else(|| {
		DesktopError::background_unavailable(
			"skylight-spi-missing: required SkyLight background input symbols are unavailable; retry \
			 with delivery:\"foreground\" or use ax actions",
		)
	})
}

fn resolve_required() -> Option<RequiredSpi> {
	ensure_skylight_loaded()?;
	let psn = PsnLookup {
		main_connection:     Some(symbol(c"CGSMainConnectionID")?),
		get_window_owner:    symbol(c"SLSGetWindowOwner"),
		get_connection_psn:  symbol(c"SLSGetConnectionPSN"),
		get_process_for_pid: symbol(c"GetProcessForPID"),
	};
	if !psn.can_resolve() {
		return None;
	}
	Some(RequiredSpi {
		post_to_pid: symbol(c"SLEventPostToPid")?,
		set_integer: symbol(c"SLEventSetIntegerValueField")?,
		post_record: symbol(c"SLPSPostEventRecordTo")?,
		set_window_location: symbol(c"CGEventSetWindowLocation")?,
		psn,
	})
}

fn resolve_foreground() -> Option<ForegroundSpi> {
	ensure_skylight_loaded()?;
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
		psn,
	})
}

fn ensure_skylight_loaded() -> Option<()> {
	static LOADED: LazyLock<bool> = LazyLock::new(|| {
		let path = c"/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight";
		// SAFETY: `path` is a static NUL-terminated framework path; the handle is
		// intentionally process-lived.
		!unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_NOW | libc::RTLD_GLOBAL) }.is_null()
	});
	if *LOADED { Some(()) } else { None }
}

fn symbol<T: Copy>(name: &CStr) -> Option<T> {
	// SAFETY: `name` is NUL-terminated and RTLD_DEFAULT is valid for process-wide
	// lookup.
	let raw = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
	if raw.is_null() {
		return None;
	}
	// SAFETY: Every callsite requests the exact C signature documented in its
	// function-pointer alias.
	Some(unsafe { mem::transmute_copy::<*mut c_void, T>(&raw) })
}

fn event_ptr(event: &CGEvent) -> *mut c_void {
	event.as_ptr().cast()
}

pub(super) fn stamp_event(
	event: &CGEvent,
	pid: pid_t,
	wid: u32,
	window_local: CGPoint,
	phase: i64,
	click_state: i64,
	button_number: i64,
) -> CoreResult<()> {
	let spi = required()?;
	let ptr = event_ptr(event);
	// SAFETY: The event is alive for these calls; all function pointers passed the
	// atomic exact-signature probe.
	unsafe {
		(spi.set_integer)(ptr, 0, phase);
		(spi.set_integer)(ptr, 1, click_state);
		(spi.set_integer)(ptr, 3, button_number);
		(spi.set_integer)(ptr, 7, 3);
		(spi.set_integer)(ptr, 40, i64::from(pid));
		(spi.set_integer)(ptr, 51, i64::from(wid));
		// Field 58 is the event timestamp, not a click-group identifier. Leave
		// Quartz's timestamp intact so receivers can order and age input normally.
		(spi.set_integer)(ptr, 91, i64::from(wid));
		(spi.set_integer)(ptr, 92, i64::from(wid));
		(spi.set_window_location)(ptr, window_local);
	}
	Ok(())
}

pub(super) fn post_pointer(pid: pid_t, event: &CGEvent) -> CoreResult<()> {
	let spi = required()?;
	// Posting through both SkyLight and CoreGraphics delivers two copies to raw
	// AppKit views. Each pointer event must enter the target queue exactly once.
	// SAFETY: `event` remains retained and `post_to_pid` has its probed exact ABI.
	unsafe { (spi.post_to_pid)(pid, event_ptr(event)) };
	Ok(())
}

#[allow(clippy::unnecessary_wraps, reason = "matches the fallible keyboard dispatch callback")]
pub(super) fn post_keyboard(pid: pid_t, event: &CGEvent) -> CoreResult<()> {
	// Use the ordinary process event queue exactly once. Authenticated private
	// posting bypasses Chromium's native menu dispatch, breaking Command chords.
	event.post_to_pid(pid);
	Ok(())
}

pub(super) fn activate_without_raise(pid: pid_t, wid: u32) -> CoreResult<BackgroundActivation> {
	let spi = required()?;
	let target = process_psn(spi.psn, pid, wid).ok_or_else(|| {
		DesktopError::background_unavailable(format!(
			"window {wid} could not resolve its process serial number for background input; retry \
			 with delivery:\"foreground\" or use ax actions",
		))
	})?;
	let mut record = [0u8; EVENT_RECORD_LENGTH];
	record[0x04] = EVENT_RECORD_LENGTH_BYTE;
	record[0x08] = EVENT_RECORD_KIND;
	record[WINDOW_ID_OFFSET..WINDOW_ID_OFFSET + 4].copy_from_slice(&wid.to_le_bytes());
	// Activate only the target's event handling. Deactivating the unrelated
	// foreground process causes a real Chromium blur even without a global
	// application switch, disrupting the user's current interaction.
	record[FOCUS_MARKER_OFFSET] = 0x01;
	// SAFETY: The target PSN and complete record live through the synchronous call.
	let focused = unsafe { (spi.post_record)(&target, record.as_ptr()) } == 0;
	if !focused {
		return Err(DesktopError::background_unavailable(format!(
			"window {wid} rejected the 248-byte SkyLight focus-without-raise record; retry with \
			 delivery:\"foreground\" or use ax actions",
		)));
	}
	thread::sleep(Duration::from_millis(50));
	Ok(BackgroundActivation { target, pid })
}

pub(super) fn with_foreground<T>(
	pid: pid_t,
	wid: u32,
	action: impl FnOnce() -> CoreResult<T>,
) -> CoreResult<T> {
	let Some(spi) = FOREGROUND.as_ref() else {
		return with_public_foreground(pid, action);
	};
	let mut previous = ProcessSerialNumber::default();
	// SAFETY: `previous` is a writable PSN and the foreground-only function pointer
	// passed its exact-signature probe.
	let previous_known = unsafe { (spi.get_front)(&mut previous) } == 0;
	let Some(target) = process_psn(spi.psn, pid, wid) else {
		return with_public_foreground(pid, action);
	};
	// SAFETY: Target PSN is valid and 0x400 is kCPSNoWindows, used only by this
	// foreground delivery rung.
	if unsafe { (spi.set_front)(&target, wid, 0x400) } != 0 {
		return with_public_foreground(pid, action);
	}
	thread::sleep(Duration::from_millis(40));
	let result = action();
	thread::sleep(Duration::from_millis(40));
	if previous_known {
		// SAFETY: The saved PSN came from WindowServer; window id 0 restores that
		// process after foreground input.
		unsafe { (spi.set_front)(&previous, 0, 0x400) };
	}
	result
}

fn with_public_foreground<T>(pid: pid_t, action: impl FnOnce() -> CoreResult<T>) -> CoreResult<T> {
	let workspace = NSWorkspace::sharedWorkspace();
	let previous = workspace.frontmostApplication();
	let target =
		NSRunningApplication::runningApplicationWithProcessIdentifier(pid).ok_or_else(|| {
			DesktopError::window_not_found(format!("application process {pid} is no longer running"))
		})?;
	#[allow(deprecated, reason = "public foreground fallback must override another frontmost app")]
	let options = NSApplicationActivationOptions::ActivateAllWindows
		| NSApplicationActivationOptions::ActivateIgnoringOtherApps;
	if !target.activateWithOptions(options) {
		return Err(DesktopError::input_failed(format!(
			"public foreground activation for process {pid} was rejected"
		)));
	}
	thread::sleep(Duration::from_millis(40));
	let result = action();
	thread::sleep(Duration::from_millis(40));
	if let Some(previous) = previous {
		#[allow(
			deprecated,
			reason = "restoring the prior frontmost app requires the same activation option"
		)]
		let restore_options = NSApplicationActivationOptions::ActivateIgnoringOtherApps;
		let _ = previous.activateWithOptions(restore_options);
	}
	result
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
			// SAFETY: `psn` is writable and has the exact 8-byte layout required by the
			// SPI.
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
