//! The macOS agent-cursor overlay helper (`cursor/helper.m`): one per omp
//! process, started by the cursor queue's thread on its first event and
//! ending when this process closes its stdin, on exit or crash alike.

use std::{
	io::Write,
	os::unix::process::CommandExt,
	process::{Child, ChildStdin, Command, Stdio},
	sync::mpsc::Receiver,
	time::{Duration, Instant},
};

use objc2_core_graphics::{
	CGDisplayBounds, CGDisplayMirrorsDisplay, CGError, CGGetActiveDisplayList,
};
use objc2_foundation::NSProcessInfo;

use crate::desktop::{
	cursor::{self, CursorEvent, CursorKind, Screen},
	error::{CoreResult, DesktopError},
	native_helper::HelperDirectory,
};

const HELPER: &[u8] = include_bytes!(env!("OMP_CURSOR_DARWIN_HELPER"));

/// The helper's executable name. Display captures leave out every
/// application of this name, so no omp process's screenshot shows any omp
/// process's cursor.
pub(in crate::desktop) const HELPER_NAME: &str = "omp-agent-cursor";

/// Helper deaths in a row after which this process stops drawing cursors.
const MAX_FAILURES: u32 = 3;

/// How long a helper must have run for its death not to count towards
/// [`MAX_FAILURES`] again.
const HEALTHY_RUN: Duration = Duration::from_secs(10);

struct Helper {
	child:      Child,
	stdin:      ChildStdin,
	started:    Instant,
	/// Removed here when the helper dies early; at exit the helper removes it.
	_directory: HelperDirectory,
}

impl Helper {
	fn start() -> CoreResult<Self> {
		let directory = HelperDirectory::create("omp-cursor")?;
		let executable = directory.write(HELPER_NAME, HELPER, 0o700)?;
		let mut child = Command::new(executable)
			// Its own group: the terminal's signals to omp's group (Ctrl-C, a
			// closed terminal, Ctrl-Z) never reach it; omp's stdin pipe closing,
			// on exit or crash alike, is the one thing that ends it.
			.process_group(0)
			.stdin(Stdio::piped())
			.stdout(Stdio::null())
			.stderr(Stdio::null())
			.spawn()
			.map_err(|error| {
				DesktopError::internal(format!("cannot start the agent cursor overlay: {error}"))
			})?;
		let stdin = child.stdin.take().expect("the helper's stdin is piped");
		Ok(Self { child, stdin, started: Instant::now(), _directory: directory })
	}
}

impl Drop for Helper {
	fn drop(&mut self) {
		let _ = self.child.kill();
		let _ = self.child.wait();
	}
}

/// Active displays in global top-left points; a display mirroring another
/// draws nothing of its own, so it is left out.
fn screens() -> Vec<Screen> {
	let mut ids = [0u32; 16];
	let mut count = 0;
	// SAFETY: The array holds `ids.len()` display ids and `count` is a live
	// u32 for the duration of this synchronous call.
	let error = unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) };
	if error != CGError::Success {
		return Vec::new();
	}
	ids[..count as usize]
		.iter()
		.filter(|&&id| CGDisplayMirrorsDisplay(id) == 0)
		.map(|&id| {
			let bounds = CGDisplayBounds(id);
			Screen {
				id,
				x: bounds.origin.x,
				y: bounds.origin.y,
				width: bounds.size.width,
				height: bounds.size.height,
			}
		})
		.collect()
}

/// Writes each event to the helper, starting it on the first one it can
/// draw. macOS before 14 draws none: its display captures cannot leave the
/// overlay out.
pub(in crate::desktop) fn serve(events: &Receiver<CursorEvent>) {
	if NSProcessInfo::processInfo()
		.operatingSystemVersion()
		.majorVersion
		< 14
	{
		return;
	}
	let mut helper: Option<Helper> = None;
	let mut failures = 0;
	for event in events {
		let Some(line) = cursor::encode(&event, &screens()) else {
			continue;
		};
		if helper.is_none() {
			if event.kind == CursorKind::Hide {
				continue;
			}
			let Ok(started) = Helper::start() else {
				failures += 1;
				if failures >= MAX_FAILURES {
					return;
				}
				continue;
			};
			helper = Some(started);
		}
		let Some(running) = helper.as_mut() else {
			continue;
		};
		if running.stdin.write_all(&line).is_ok() {
			if running.started.elapsed() >= HEALTHY_RUN {
				failures = 0;
			}
			continue;
		}
		// It exited; the next event starts another.
		helper = None;
		failures += 1;
		if failures >= MAX_FAILURES {
			return;
		}
	}
}
