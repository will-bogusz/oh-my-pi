//! Releases of `XTest` keys and buttons that outlive the process that pressed
//! them.
//!
//! Each `XTest` call releases what it pressed on success, error and
//! cancellation, but only while omp lives. Xorg keeps an `XTest` key or button
//! down after the client that pressed it is gone (`Xext/xtest.c` has no
//! cleanup), so an omp killed mid-press left the user's Shift or left button
//! held for the whole X session. A call that can press through `XTest`
//! therefore forks a watcher first and tells it each press before sending it
//! and each release after. The watcher owns an X connection of its own; when
//! its stream ends with presses still open, because omp died or its own
//! release failed, it sends their releases there and exits. A call that ends
//! normally closes the stream and reaps the watcher, which sends nothing.
//!
//! Between `fork` and `_exit` the watcher makes only async-signal-safe calls:
//! it never allocates, locks or unwinds, which is what a fork from a
//! multi-threaded host allows.

use std::{
	io,
	mem::MaybeUninit,
	os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
	time::{Duration, Instant},
};

use x11rb::{
	connection::RequestConnection as _,
	protocol::{
		xproto::{BUTTON_RELEASE_EVENT, KEY_RELEASE_EVENT, Window},
		xtest,
	},
};

/// One `XTest` key or button, by X keycode or button number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Held {
	Key(u8),
	Button(u8),
}

impl Held {
	/// The two-byte stream message for this input's press or release.
	const fn message(self, press: bool) -> [u8; 2] {
		let (kind, code) = match self {
			Self::Key(code) => (0, code),
			Self::Button(code) => (BUTTON, code),
		};
		[kind | if press { PRESS } else { 0 }, code]
	}
}

const BUTTON: u8 = 1;
const PRESS: u8 = 2;
/// Bytes in one `XTest` `FakeInput` request.
const REQUEST_LEN: usize = 36;
/// Offsets of the event type and detail in a `FakeInput` request.
const REQUEST_TYPE: usize = 4;
const REQUEST_DETAIL: usize = 5;
/// How long dropping a guard waits for its watcher to exit before killing it.
const EXIT_TIMEOUT: Duration = Duration::from_millis(500);
/// The watcher's thread name.
const WATCHER_NAME: &[u8] = b"xtest-release\0";
/// Signals sent to end a hung omp, which reach the watcher too through its
/// process name, its command line (a fork keeps omp's) or omp's cgroup. The
/// watcher ignores them and ends with its stream instead.
const IGNORED: [libc::c_int; 5] =
	[libc::SIGTERM, libc::SIGINT, libc::SIGHUP, libc::SIGQUIT, libc::SIGPIPE];

/// The keys and buttons a stream still holds, one bit per code.
#[derive(Default)]
struct Open {
	keys:    [u8; 32],
	buttons: [u8; 32],
}

impl Open {
	fn apply(&mut self, [flags, code]: [u8; 2]) {
		let bits = if flags & BUTTON == 0 {
			&mut self.keys
		} else {
			&mut self.buttons
		};
		let (byte, bit) = (usize::from(code >> 3), 1u8 << (code & 7));
		if flags & PRESS == 0 {
			bits[byte] &= !bit;
		} else {
			bits[byte] |= bit;
		}
	}

	/// Each open input, keys first.
	fn each(&self, mut release: impl FnMut(Held)) {
		let set = |bits: &[u8; 32], code: u8| bits[usize::from(code >> 3)] & (1 << (code & 7)) != 0;
		for code in 0..=u8::MAX {
			if set(&self.keys, code) {
				release(Held::Key(code));
			}
		}
		for code in 0..=u8::MAX {
			if set(&self.buttons, code) {
				release(Held::Button(code));
			}
		}
	}
}

/// A forked watcher that releases whatever this call still holds when its
/// stream ends.
pub(super) struct ReleaseGuard {
	watcher: libc::pid_t,
	stream:  OwnedFd,
}

impl ReleaseGuard {
	/// Forks the watcher with its own X connection to the `DISPLAY` server,
	/// whose root window is `root`. `None` when it cannot start; the call
	/// then runs without one.
	pub(super) fn start(root: Window) -> Option<Self> {
		let (conn, _) = x11rb::connect(None).ok()?;
		let major_opcode = conn
			.extension_information(xtest::X11_EXTENSION_NAME)
			.ok()??
			.major_opcode;
		Self::spawn(conn.stream().as_raw_fd(), &release_request(major_opcode, root), true).ok()
	}

	/// Forks a watcher that sends its releases on `x11`. `close_rest` closes
	/// the descriptors it does not need through `close_range`, which a kernel
	/// before 5.9 or a seccomp filter may refuse.
	fn spawn(x11: RawFd, template: &[u8; REQUEST_LEN], close_rest: bool) -> io::Result<Self> {
		let mut ends = [0; 2];
		// SAFETY: `ends` has room for the two descriptors socketpair writes.
		if unsafe {
			libc::socketpair(
				libc::AF_UNIX,
				libc::SOCK_STREAM | libc::SOCK_CLOEXEC,
				0,
				ends.as_mut_ptr(),
			)
		} != 0
		{
			return Err(io::Error::last_os_error());
		}
		// SAFETY: socketpair succeeded, so both descriptors are open and owned
		// here alone.
		let (stream, watched) =
			unsafe { (OwnedFd::from_raw_fd(ends[0]), OwnedFd::from_raw_fd(ends[1])) };
		// No host signal handler may run in the child before `watch` resets
		// them, so every signal stays blocked across the fork.
		let mut all = MaybeUninit::<libc::sigset_t>::uninit();
		let mut previous = MaybeUninit::<libc::sigset_t>::uninit();
		// SAFETY: both sets are written by sigfillset / pthread_sigmask before
		// they are read; fork's child runs only `watch`, which makes
		// async-signal-safe calls and ends in `_exit`.
		unsafe {
			libc::sigfillset(all.as_mut_ptr());
			libc::pthread_sigmask(libc::SIG_SETMASK, all.as_ptr(), previous.as_mut_ptr());
			let forked = libc::fork();
			if forked == 0 {
				watch(stream.as_raw_fd(), watched.as_raw_fd(), x11, template, close_rest);
			}
			libc::pthread_sigmask(libc::SIG_SETMASK, previous.as_ptr(), std::ptr::null_mut());
			match forked {
				-1 => Err(io::Error::last_os_error()),
				watcher => Ok(Self { watcher, stream }),
			}
		}
	}

	/// Tells the watcher `held` goes down, before the press goes out.
	pub(super) fn pressing(&self, held: Held) {
		let _ = self.send(held.message(true));
	}

	/// Tells the watcher `held` went up, after the release went out. A
	/// watcher that misses it sends one more release, which the server drops
	/// for an input that is not down.
	pub(super) fn released(&self, held: Held) {
		let _ = self.send(held.message(false));
	}

	fn send(&self, message: [u8; 2]) -> io::Result<()> {
		// SAFETY: the stream is open and `message` outlives the call.
		let sent = unsafe {
			libc::send(self.stream.as_raw_fd(), message.as_ptr().cast(), 2, libc::MSG_NOSIGNAL)
		};
		match sent {
			2 => Ok(()),
			-1 => Err(io::Error::last_os_error()),
			_ => Err(io::Error::new(io::ErrorKind::WriteZero, "short write")),
		}
	}
}

impl Drop for ReleaseGuard {
	fn drop(&mut self) {
		// Closing the stream ends the watcher, which by now holds nothing. A
		// watcher that does not exit in time (stopped, or stuck before its
		// first read) is killed, so the call never waits on it for long.
		// SAFETY: shutdown takes an open descriptor and no pointers.
		unsafe { libc::shutdown(self.stream.as_raw_fd(), libc::SHUT_RDWR) };
		let deadline = Instant::now() + EXIT_TIMEOUT;
		loop {
			// SAFETY: waitpid on our own child with a null status pointer.
			let reaped = unsafe { libc::waitpid(self.watcher, std::ptr::null_mut(), libc::WNOHANG) };
			// -1 is also ECHILD, a host that reaps or ignores its children.
			if reaped != 0 {
				return;
			}
			if Instant::now() >= deadline {
				break;
			}
			std::thread::sleep(Duration::from_millis(1));
		}
		// SAFETY: kill and waitpid on our own child, which has not been
		// reaped, so its pid is still ours.
		unsafe {
			libc::kill(self.watcher, libc::SIGKILL);
			while libc::waitpid(self.watcher, std::ptr::null_mut(), 0) == -1
				&& *libc::__errno_location() == libc::EINTR
			{}
		}
	}
}

/// A `FakeInput` key release for `root`; the watcher sets the type and
/// detail of each one it sends.
fn release_request(major_opcode: u8, root: Window) -> [u8; REQUEST_LEN] {
	let ([request], _) = xtest::FakeInputRequest {
		type_: KEY_RELEASE_EVENT,
		detail: 0,
		time: x11rb::CURRENT_TIME,
		root,
		root_x: 0,
		root_y: 0,
		deviceid: 0,
	}
	.serialize(major_opcode);
	let mut template = [0; REQUEST_LEN];
	template.copy_from_slice(&request);
	template
}

/// The release request `template` sends for `held`.
const fn release_of(template: &[u8; REQUEST_LEN], held: Held) -> [u8; REQUEST_LEN] {
	let mut request = *template;
	(request[REQUEST_TYPE], request[REQUEST_DETAIL]) = match held {
		Held::Key(code) => (KEY_RELEASE_EVENT, code),
		Held::Button(code) => (BUTTON_RELEASE_EVENT, code),
	};
	request
}

/// The forked watcher. Leaves omp's session and process group, resets omp's
/// signal handlers and ignores the signals that end a hung omp, keeps only
/// `watched` and `x11` of omp's descriptors, follows the stream until it
/// ends, then sends a release for each input still open.
fn watch(
	parent: RawFd,
	watched: RawFd,
	x11: RawFd,
	template: &[u8; REQUEST_LEN],
	close_rest: bool,
) -> ! {
	// SAFETY: every call below is async-signal-safe and touches only this
	// process's own state and the stack.
	unsafe {
		// omp's end of the stream first: while the watcher holds a copy, the
		// stream never ends when omp dies.
		libc::close(parent);
		// Out of omp's process group and terminal, so a terminal hangup or a
		// Ctrl+C sent to omp's group reaches omp alone.
		libc::setsid();
		libc::prctl(libc::PR_SET_NAME, WATCHER_NAME.as_ptr());
		for signal in 1..=libc::SIGRTMAX() {
			let action = if IGNORED.contains(&signal) {
				libc::SIG_IGN
			} else {
				libc::SIG_DFL
			};
			libc::signal(signal, action);
		}
		let mut unblocked = MaybeUninit::<libc::sigset_t>::uninit();
		libc::sigemptyset(unblocked.as_mut_ptr());
		libc::sigprocmask(libc::SIG_SETMASK, unblocked.as_ptr(), std::ptr::null_mut());
		if close_rest {
			close_others(watched, x11);
		}
		let stream = watched;
		let mut open = Open::default();
		let mut message = [0u8; 2];
		let mut filled = 0;
		loop {
			let read = libc::read(stream, message.as_mut_ptr().add(filled).cast(), 2 - filled);
			if read > 0 {
				filled += read.unsigned_abs();
				if filled == 2 {
					open.apply(message);
					filled = 0;
				}
			} else if read == 0 || *libc::__errno_location() != libc::EINTR {
				break;
			}
		}
		open.each(|held| {
			let request = release_of(template, held);
			libc::send(x11, request.as_ptr().cast(), REQUEST_LEN, libc::MSG_NOSIGNAL);
		});
		libc::_exit(0)
	}
}

/// Closes every descriptor from 3 up except `a` and `b`, so the watcher
/// keeps none of omp's pipes or sockets open. A kernel without
/// `close_range` leaves them until the watcher exits; omp's end of the
/// stream is closed apart, so the watcher still sees omp die.
fn close_others(a: RawFd, b: RawFd) {
	let fd = |fd: RawFd| libc::c_uint::try_from(fd).unwrap_or(0);
	let (low, high) = (fd(a.min(b)), fd(a.max(b)));
	let mut from: libc::c_uint = 3;
	for keep in [low, high, libc::c_uint::MAX] {
		if from < keep {
			// SAFETY: close_range takes integers only.
			unsafe { libc::syscall(libc::SYS_close_range, from, keep - 1, 0) };
		}
		from = from.max(keep.saturating_add(1));
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn open_inputs_follow_their_presses_and_releases() {
		let mut open = Open::default();
		for (held, press) in [
			(Held::Key(50), true),
			(Held::Key(38), true),
			(Held::Button(1), true),
			(Held::Key(38), false),
			(Held::Button(255), true),
			(Held::Button(255), false),
			(Held::Key(255), true),
		] {
			open.apply(held.message(press));
		}
		let mut left = Vec::new();
		open.each(|held| left.push(held));
		assert_eq!(left, [Held::Key(50), Held::Key(255), Held::Button(1)]);
	}

	#[test]
	fn a_release_request_is_the_fake_input_x11rb_would_send() {
		let template = release_request(140, 0x1234_5678);
		for (held, type_, detail) in
			[(Held::Key(50), KEY_RELEASE_EVENT, 50), (Held::Button(3), BUTTON_RELEASE_EVENT, 3)]
		{
			let ([expected], _) = xtest::FakeInputRequest {
				type_,
				detail,
				time: x11rb::CURRENT_TIME,
				root: 0x1234_5678,
				root_x: 0,
				root_y: 0,
				deviceid: 0,
			}
			.serialize(140);
			assert_eq!(release_of(&template, held).as_slice(), &*expected);
		}
	}

	/// A watcher on a socket pair standing in for its X connection, and the
	/// server end that reads what it sends.
	fn watched(close_rest: bool) -> (ReleaseGuard, std::os::unix::net::UnixStream) {
		let (server, x11) = std::os::unix::net::UnixStream::pair().unwrap();
		server
			.set_read_timeout(Some(Duration::from_secs(10)))
			.unwrap();
		let guard = ReleaseGuard::spawn(x11.as_raw_fd(), &release_request(140, 1), close_rest)
			.expect("the watcher starts");
		(guard, server)
	}

	fn received(mut server: std::os::unix::net::UnixStream) -> Vec<u8> {
		let mut bytes = Vec::new();
		std::io::Read::read_to_end(&mut server, &mut bytes).expect("the watcher's X end closes");
		bytes
	}

	/// omp dying closes its end of the stream without the drop's shutdown,
	/// with `close_range` or without it, and with or without a SIGTERM aimed
	/// at omp reaching the watcher first.
	#[test]
	fn a_dead_owners_open_inputs_are_released() {
		for (close_rest, terminate) in [(true, false), (false, false), (true, true)] {
			let (guard, server) = watched(close_rest);
			guard.pressing(Held::Key(50));
			guard.pressing(Held::Button(1));
			guard.released(Held::Button(1));
			let guard = std::mem::ManuallyDrop::new(guard);
			let watcher = guard.watcher;
			if terminate {
				// SAFETY: kill takes integers only; `watcher` is our unreaped
				// child.
				unsafe { libc::kill(watcher, libc::SIGTERM) };
			}
			// SAFETY: the guard is never dropped, so its stream is closed once.
			drop(unsafe { std::ptr::read(&guard.stream) });
			let expected = release_of(&release_request(140, 1), Held::Key(50));
			assert_eq!(received(server), expected, "close_rest {close_rest}, SIGTERM {terminate}");
			// SAFETY: waitpid on our own child with a null status pointer.
			assert_eq!(unsafe { libc::waitpid(watcher, std::ptr::null_mut(), 0) }, watcher);
		}
	}

	#[test]
	fn a_call_that_releases_everything_sends_nothing() {
		let (guard, server) = watched(true);
		guard.pressing(Held::Key(50));
		guard.released(Held::Key(50));
		drop(guard);
		assert!(received(server).is_empty(), "a call that released everything sent releases");
	}

	/// A stopped watcher is killed and reaped instead of holding the call.
	#[test]
	fn dropping_a_guard_does_not_wait_on_a_stopped_watcher() {
		let (guard, _server) = watched(true);
		let watcher = guard.watcher;
		// SAFETY: kill takes integers only; `watcher` is our unreaped child.
		unsafe { libc::kill(watcher, libc::SIGSTOP) };
		drop(guard);
		// SAFETY: as above; the drop reaped it, so nothing is left to wait for.
		assert_eq!(unsafe { libc::waitpid(watcher, std::ptr::null_mut(), libc::WNOHANG) }, -1);
	}
}
