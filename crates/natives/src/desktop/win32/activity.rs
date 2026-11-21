//! When the session last had input, so a takeover does not start while the
//! user is typing, clicking or moving the pointer: once the target is in front
//! it holds the keyboard, and the user's keys would land in it.
//!
//! Windows dates only the session's newest input, of any kind and from any
//! program (`GetLastInputInfo`), OMP's own `SendInput` included. So each of
//! OMP's sends first reads the date it is about to overwrite, keeping the
//! user's input from just before it, then records the timer ticks before and
//! after it: a date inside OMP's newest send is OMP's. Nothing is registered
//! and no hook or thread is added.
use std::time::Duration;

#[cfg(target_os = "windows")]
use parking_lot::{Mutex, MutexGuard};
#[cfg(target_os = "windows")]
use windows_sys::Win32::{
	System::SystemInformation::GetTickCount64,
	UI::Input::KeyboardAndMouse::{
		GetAsyncKeyState, GetLastInputInfo, LASTINPUTINFO, VK_CONTROL, VK_LBUTTON, VK_LWIN,
		VK_MBUTTON, VK_MENU, VK_RBUTTON, VK_RWIN, VK_SHIFT, VK_XBUTTON1, VK_XBUTTON2,
	},
};

#[cfg(target_os = "windows")]
use crate::desktop::control;
use crate::desktop::{
	control::USER_QUIET as QUIET,
	error::{CoreResult, DesktopError},
};

/// How often an admission waiting on a button or modifier the user holds
/// checks whether they have let go.
const HELD_POLL: Duration = Duration::from_millis(50);
/// A send that took longer may have been descheduled while the user typed, so
/// input dated inside it counts as the user's.
const MAX_SEND: Duration = Duration::from_millis(50);

/// What the session's input dates say, on `GetTickCount64`'s clock.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct History {
	/// The newest input that was not OMP's.
	user: Option<Duration>,
	/// OMP's newest send: the clock before and after it.
	own:  Option<(Duration, Duration)>,
}

impl History {
	/// Folds in one reading of the session's last input `tick` (`GetTickCount`
	/// time, the low 32 bits of `GetTickCount64`) taken before `now`.
	fn read(&mut self, tick: u32, now: Duration) {
		let ago = (now.as_millis() as u32).wrapping_sub(tick);
		let at = now.saturating_sub(Duration::from_millis(ago.into()));
		let own = self.own.is_some_and(|(before, after)| {
			after.saturating_sub(before) <= MAX_SEND && (before..=after).contains(&at)
		});
		if !own {
			self.user = self.user.max(Some(at));
		}
	}
}

#[cfg(target_os = "windows")]
static HISTORY: Mutex<History> = Mutex::new(History { user: None, own: None });

#[cfg(target_os = "windows")]
fn now() -> Duration {
	// SAFETY: GetTickCount64 has no preconditions and is monotonic.
	Duration::from_millis(unsafe { GetTickCount64() })
}

/// Reads the session's last input into `history`; read before the clock, so
/// it is never dated after it.
#[cfg(target_os = "windows")]
fn read(history: &mut History) -> CoreResult<()> {
	let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
	// SAFETY: `info` is writable and its size is set.
	if unsafe { GetLastInputInfo(&raw mut info) } == 0 {
		return Err(DesktopError::input_failed(
			"cannot read the session's last input time, so no takeover started; nothing was sent",
		));
	}
	history.read(info.dwTime, now());
	Ok(())
}

/// OMP's input on its way out. It holds the history until [`Sending::sent`],
/// so no reading falls between a send and its record.
#[cfg(target_os = "windows")]
pub(super) struct Sending {
	history: MutexGuard<'static, History>,
	before:  Duration,
}

/// Before OMP sends input: keeps the user's input the send is about to
/// overwrite.
#[cfg(target_os = "windows")]
pub(super) fn sending() -> Sending {
	let mut history = HISTORY.lock();
	// The send goes on unread; a takeover's own admission reads again and
	// fails when the date cannot be read.
	let _ = read(&mut history);
	Sending { history, before: now() }
}

#[cfg(target_os = "windows")]
impl Sending {
	/// Ends the send, recording it when Windows `inserted` any of it.
	pub(super) fn sent(mut self, inserted: bool) {
		if inserted {
			self.history.own = Some((self.before, now()));
		}
	}
}

/// The newest input that was not OMP's.
#[cfg(target_os = "windows")]
fn last_input() -> CoreResult<Option<Duration>> {
	let mut history = HISTORY.lock();
	read(&mut history)?;
	Ok(history.user)
}

/// Whether the user holds a mouse button or a modifier, which would change
/// what the takeover's own input does.
#[cfg(target_os = "windows")]
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

/// Before a window or element takeover takes the input lease: waits until the
/// session has had no input but OMP's for [`QUIET`] and the user holds no
/// button or modifier, at most until shortly before the call's deadline.
/// Returns the user's last input, which [`admitted`] compares.
#[cfg(target_os = "windows")]
pub(super) fn admit() -> CoreResult<Option<Duration>> {
	let limit = now() + control::time_left().unwrap_or(QUIET);
	admit_with(limit, now, last_input, input_held, control::wait)
}

/// With the input lease held: whether the session has had no input but OMP's
/// since [`admit`] returned `admitted`, and the user holds nothing.
#[cfg(target_os = "windows")]
pub(super) fn admitted(admitted: Option<Duration>) -> CoreResult<bool> {
	Ok(last_input()? == admitted && !input_held())
}

fn admit_with(
	limit: Duration,
	now: impl Fn() -> Duration,
	mut last_input: impl FnMut() -> CoreResult<Option<Duration>>,
	held: impl Fn() -> bool,
	mut wait: impl FnMut(Duration) -> CoreResult<()>,
) -> CoreResult<Option<Duration>> {
	loop {
		let user = last_input()?;
		let holding = held();
		let now = now();
		let Some(active) = (if holding { Some(now) } else { user }) else {
			return Ok(user);
		};
		let idle = now.saturating_sub(active);
		if idle >= QUIET {
			return Ok(user);
		}
		if now >= limit {
			return Err(DesktopError::user_intervened(if holding {
				"the user is holding a mouse button or modifier, so no takeover started; nothing was \
				 sent; try again once they let go"
					.to_owned()
			} else {
				format!(
					"the session had input {:.1} s ago (a key, click or pointer move, from any program \
					 but omp), so no takeover started; nothing was sent; try again once the user pauses",
					idle.as_secs_f64(),
				)
			}));
		}
		let quiet = (active + QUIET).min(limit).saturating_sub(now);
		wait(if holding { HELD_POLL.min(quiet) } else { quiet })?;
	}
}

#[cfg(test)]
mod tests {
	use std::cell::Cell;

	use super::*;
	use crate::desktop::error::ErrorCode;

	const fn ms(value: u64) -> Duration {
		Duration::from_millis(value)
	}

	/// A history whose newest send ran from `before` to `after` ms, read at
	/// `tick` (`GetTickCount` time) when the clock shows `now` ms.
	fn user_after(own: Option<(u64, u64)>, tick: u32, now: u64) -> Option<Duration> {
		let mut history =
			History { user: None, own: own.map(|(before, after)| (ms(before), ms(after))) };
		history.read(tick, ms(now));
		history.user
	}

	#[test]
	fn only_input_dated_inside_omps_newest_short_send_is_omps() {
		const WRAP: u64 = 1 << 32;
		let rows = [
			("no send yet", None, 1_000, 3_000, Some(1_000)),
			("inside the send", Some((990, 1_010)), 1_000, 3_000, None),
			("at its first tick", Some((990, 1_010)), 990, 3_000, None),
			("at its last tick", Some((990, 1_010)), 1_010, 3_000, None),
			("one tick before it", Some((990, 1_010)), 989, 3_000, Some(989)),
			("one tick after it", Some((990, 1_010)), 1_011, 3_000, Some(1_011)),
			("inside a send too long to be sure", Some((990, 1_041)), 1_000, 3_000, Some(1_000)),
			// The send straddles GetTickCount's wrap; the tick is past it.
			("inside a send across the wrap", Some((WRAP - 5, WRAP + 5)), 2, WRAP + 100, None),
			(
				"after a send across the wrap",
				Some((WRAP - 5, WRAP + 5)),
				6,
				WRAP + 100,
				Some(WRAP + 6),
			),
		];
		for (case, own, tick, now, user) in rows {
			assert_eq!(user_after(own, tick, now), user.map(ms), "{case}");
		}
	}

	#[test]
	fn the_users_input_before_an_omp_send_outlives_it() {
		let mut history = History::default();
		// The user typed at 1000; the send starting at 1500 reads that date
		// before overwriting it, then its own input is dated 1500.
		history.read(1_000, ms(1_500));
		history.own = Some((ms(1_500), ms(1_502)));
		history.read(1_500, ms(1_600));
		assert_eq!(history.user, Some(ms(1_000)));
		// An older date read later never moves it back.
		history.read(900, ms(1_700));
		assert_eq!(history.user, Some(ms(1_000)));
	}

	/// Runs an admission from `start` ms with a deadline at `limit` ms, the
	/// user's last input `user` and a button held until `held_until` ms, whose
	/// release Windows dates as input.
	fn admit(
		start: u64,
		limit: u64,
		user: Option<u64>,
		held_until: u64,
	) -> (CoreResult<Option<Duration>>, Vec<Duration>) {
		let clock = Cell::new(ms(start));
		let mut waits = Vec::new();
		let released =
			|now: Duration| (held_until != 0 && now >= ms(held_until)).then(|| ms(held_until));
		let result = admit_with(
			ms(limit),
			|| clock.get(),
			|| Ok(user.map(ms).max(released(clock.get()))),
			|| clock.get() < ms(held_until),
			|duration| {
				waits.push(duration);
				clock.set(clock.get() + duration);
				Ok(())
			},
		);
		(result, waits)
	}

	#[test]
	fn admission_waits_for_quiet_bounded_by_the_deadline() {
		// Idle for longer than the quiet period, or never seen: no wait.
		let (result, waits) = admit(10_000, 30_000, Some(4_000), 0);
		assert_eq!((result.unwrap(), waits), (Some(ms(4_000)), vec![]));
		let (result, waits) = admit(10_000, 30_000, None, 0);
		assert_eq!((result.unwrap(), waits), (None, vec![]));
		// Input 1 s ago: waits the 4 s left of the quiet period.
		let (result, waits) = admit(10_000, 30_000, Some(9_000), 0);
		assert_eq!((result.unwrap(), waits), (Some(ms(9_000)), vec![ms(4_000)]));
		// A held button is polled until let go; quiet runs from the release.
		let (result, waits) = admit(10_000, 30_000, None, 10_120);
		assert_eq!(
			(result.unwrap(), waits),
			(Some(ms(10_120)), vec![ms(50), ms(50), ms(50), ms(4_970)])
		);
		// The deadline comes first: refused once it is reached, nothing sent.
		let (result, waits) = admit(10_000, 12_000, Some(9_000), 0);
		assert_eq!(result.unwrap_err().code, ErrorCode::UserIntervened);
		assert_eq!(waits, [ms(2_000)]);
	}
}
