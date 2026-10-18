//! The app in front of the user, read before omp's own input reaches a
//! background target, so it can be put back if that input brings another app
//! forward.
#![cfg_attr(test, allow(dead_code, reason = "reached only from JavaScript, through napi"))]

use napi_derive::napi;

use crate::task;

/// The app the user had in front when `macOSFrontApp()` read it.
#[napi(js_name = "MacOSFrontApp")]
pub struct MacosFrontApp {
	#[cfg(target_os = "macos")]
	app: super::macos::FrontApp,
}

#[napi]
impl MacosFrontApp {
	/// Puts this app back in front, without raising its windows, each time the
	/// app that took the front from it takes it again during the next
	/// `durationMs`. Ends early once a hardware mouse button or ⌘/⌃ is used
	/// after the app was read, the app came from a launcher or Spotlight panel,
	/// or a different app comes forward: that is the user picking an app.
	/// Typing does not end it, and a hand-back macOS refuses for a key typed
	/// meanwhile is asked again. With `browserPid`, the app expected to take
	/// the front, the keys the user types while it holds the keyboard go to
	/// this app instead (when omp may tap keys: Accessibility). Rejects while
	/// another operation owns desktop input/focus control. Resolves how many
	/// times it put the app back.
	#[napi]
	pub fn keep_in_front(&self, duration_ms: u32, browser_pid: Option<u32>) -> task::Promise<u32> {
		#[cfg(target_os = "macos")]
		{
			let app = self.app;
			let browser = browser_pid.and_then(|pid| libc::pid_t::try_from(pid).ok());
			task::blocking("desktop.keepInFront", (), move |_| {
				app.keep_in_front(std::time::Duration::from_millis(duration_ms.into()), browser)
					.map_err(Into::into)
			})
		}
		#[cfg(not(target_os = "macos"))]
		{
			let _ = (duration_ms, browser_pid);
			task::blocking("desktop.keepInFront", (), |_| Ok(0))
		}
	}
}

/// The app at the other end of a loopback TCP connection to this process
/// from `peerPort` to `localPort`, such as the browser whose extension
/// connected to omp's relay: the pid of the process holding that end, or of
/// its nearest ancestor that is a regular app. `null` off macOS and when no
/// other process holds it.
#[napi(js_name = "macOSLoopbackPeerApp")]
pub fn macos_loopback_peer_app(local_port: u16, peer_port: u16) -> task::Promise<Option<u32>> {
	task::blocking("desktop.loopbackPeerApp", (), move |_| {
		#[cfg(target_os = "macos")]
		{
			Ok(super::macos::loopback_peer_app(local_port, peer_port)
				.and_then(|pid| u32::try_from(pid).ok()))
		}
		#[cfg(not(target_os = "macos"))]
		{
			let _ = (local_port, peer_port);
			Ok(None)
		}
	})
}

/// The app macOS `WindowServer` has in front. `null` off macOS and when the
/// front-process SPI is unavailable. With `browserPid`, the app omp's input
/// is about to reach, the keys the user types while that app holds the
/// keyboard uninvited go to this app for the next second, or through
/// `keepInFront` (when omp may tap keys: Accessibility).
#[napi(js_name = "macOSFrontApp")]
pub fn macos_front_app(browser_pid: Option<u32>) -> Option<MacosFrontApp> {
	#[cfg(target_os = "macos")]
	{
		let browser = browser_pid.and_then(|pid| libc::pid_t::try_from(pid).ok());
		super::macos::front_app(browser).map(|app| MacosFrontApp { app })
	}
	#[cfg(not(target_os = "macos"))]
	{
		let _ = browser_pid;
		None
	}
}
