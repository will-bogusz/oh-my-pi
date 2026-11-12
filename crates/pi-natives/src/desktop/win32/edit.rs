//! Decisions for putting typed text into a focused multi-line edit control
//! through its own `EM_REPLACESEL` instead of through keys.
//!
//! No Windows imports, so the host test suite exercises it on every platform.

/// Whether `after` is `before` with one range replaced by `text`: the proof
/// that an `EM_REPLACESEL` put exactly `text` into the control, taken from the
/// control's own text (`WM_GETTEXT`) rather than from where its caret went,
/// so a handler that moves the caret or a limit that cut the text cannot pass
/// for a whole insert.
pub fn spliced(before: &[u16], after: &[u16], text: &[u16]) -> bool {
	// `kept` units of `before` survive around the text.
	let Some(kept) = after.len().checked_sub(text.len()) else {
		return false;
	};
	if kept > before.len() {
		return false;
	}
	let prefix = before.iter().zip(after).take_while(|(a, b)| a == b).count();
	let suffix = before
		.iter()
		.rev()
		.zip(after.iter().rev())
		.take_while(|(a, b)| a == b)
		.count();
	// The text starts at `at`: everything before it and the `kept - at`
	// units after it are `before`'s own.
	let first = kept.saturating_sub(suffix);
	let last = prefix.min(kept);
	(first..=last).any(|at| after[at..at + text.len()] == *text)
}

/// Splits typed text into stretches of characters and the line breaks between
/// them (`true`): a line break is a Return key on every route, so only the
/// characters between two can go in as text.
pub fn stretches(text: &str) -> impl Iterator<Item = (bool, &str)> {
	let is_break = |character: char| matches!(character, '\r' | '\n');
	let mut rest = text;
	std::iter::from_fn(move || {
		let breaks = is_break(rest.chars().next()?);
		let end = rest
			.find(|character: char| is_break(character) != breaks)
			.unwrap_or(rest.len());
		let (head, tail) = rest.split_at(end);
		rest = tail;
		Some((breaks, head))
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_splice_is_proved_from_the_text_alone() {
		let w = |text: &str| text.encode_utf16().collect::<Vec<_>>();
		let spliced =
			|before: &str, after: &str, text: &str| spliced(&w(before), &w(after), &w(text));
		assert!(spliced("", "abc", "abc"));
		assert!(spliced("hello world", "hello there", "there"));
		assert!(spliced("hello world", "hello big world", " big"));
		// Text that repeats its neighbours is still one splice.
		assert!(spliced("aaa", "aaaaa", "aa"));
		assert!(spliced("one\r\ntwo", "one\r\nt😀wo", "😀"));
		// A length limit, a filter, a fold and an untouched control are not.
		assert!(!spliced("", "abc 123 de", "abc 123 def"));
		assert!(!spliced("", "123", "abc 123 def"));
		assert!(!spliced("", "ABC", "abc"));
		assert!(!spliced("locked", "locked", "abc"));
		assert!(!spliced("hello", "heXllo!", "X"));
	}

	#[test]
	fn stretches_keep_line_breaks_apart_from_characters() {
		let split = |text| stretches(text).collect::<Vec<_>>();
		assert_eq!(split(""), []);
		assert_eq!(split("one two"), [(false, "one two")]);
		assert_eq!(split("a\r\nb\n\nc\r"), [
			(false, "a"),
			(true, "\r\n"),
			(false, "b"),
			(true, "\n\n"),
			(false, "c"),
			(true, "\r")
		]);
		assert_eq!(split("\né"), [(true, "\n"), (false, "é")]);
	}
}
