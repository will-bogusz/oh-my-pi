//! What `apps.open` does for a running Win32 application, decided from its
//! top-level windows without Windows imports so the host test suite runs it
//! on every platform.

/// How `windows()` shows one of an application's top-level windows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Shown {
	/// Listed: on screen and not minimized.
	Listed,
	/// Left out of the list only because it is minimized.
	Minimized,
	/// Left out for another reason: too small, untitled, or its state is
	/// unreadable.
	Unlisted,
}

#[derive(Debug, PartialEq, Eq)]
pub(in crate::desktop) enum Reopen<W> {
	/// Launch through the shell: the application shows a listed window
	/// already, or has no minimized window to bring back.
	Launch,
	/// Restore the application's frontmost minimized window instead: as
	/// `windows()` lists none of its windows, launching it again can start a
	/// second instance rather than show the one the user minimized.
	Restore(W),
}

/// Decides from the application's top-level windows, front to back: the
/// frontmost minimized one is restored unless another is listed.
pub(super) fn reopen<W>(windows: impl IntoIterator<Item = (W, Shown)>) -> Reopen<W> {
	let mut minimized = None;
	for (window, shown) in windows {
		match shown {
			Shown::Listed => return Reopen::Launch,
			Shown::Minimized => {
				minimized.get_or_insert(window);
			},
			Shown::Unlisted => {},
		}
	}
	minimized.map_or(Reopen::Launch, Reopen::Restore)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn an_application_whose_windows_are_all_minimized_gets_its_frontmost_one_restored() {
		let windows = [(1, Shown::Unlisted), (2, Shown::Minimized), (3, Shown::Minimized)];
		assert_eq!(reopen(windows), Reopen::Restore(2));
	}

	#[test]
	fn an_application_with_a_listed_window_is_launched_as_before() {
		// A minimized window in front of a listed one is not restored: the
		// application already shows a window `windows()` can find.
		assert_eq!(reopen([(1, Shown::Minimized), (2, Shown::Listed)]), Reopen::Launch);
		assert_eq!(reopen([(1, Shown::Unlisted)]), Reopen::Launch);
	}
}
