//! Pure checks of takeover-typed text against what the focused field reads
//! back through UI Automation after typing.
//!
//! This module has no Windows imports, so the host test suite exercises the
//! verdicts and their wording on every platform.

/// Characters of field text a message quotes.
const QUOTED_CHARS: usize = 120;

/// What the focused field's text after typing says about the typed text.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
	/// The field gained the typed text.
	Confirmed,
	/// The field gained only `arrived`: some of the typed characters, in
	/// order, with others missing from between them. This is how a control
	/// that drops fast synthetic input loses text, and nothing else a field
	/// does to typed text looks like it.
	Dropped { arrived: String },
	/// The field reads otherwise, which a field can do with text it took
	/// (reformatted it, replaced a selection, submitted it, shows only part
	/// of it); the reason says what it reads.
	Unconfirmed(String),
}

/// Compares the text of `field` (what messages call it) `before` and `after`
/// typing `typed`. Line breaks compare equal in any of the `\r\n`, `\r` and
/// `\n` forms, since Return becomes whichever the control stores.
pub fn verdict(typed: &str, before: &str, after: &str, field: &str) -> Verdict {
	let (typed, before, after) = (line_breaks(typed), line_breaks(before), line_breaks(after));
	if shows(&typed, &before, &after) {
		return Verdict::Confirmed;
	}
	let arrived = gained(&before, &after);
	if may_leave_field(&typed) {
		return Verdict::Unconfirmed(format!(
			"{field} does not read as typed, and the text has Return or Tab, which can submit, clear \
			 or leave the field"
		));
	}
	if arrived.is_empty() {
		return Verdict::Unconfirmed(format!("{field}'s text did not change"));
	}
	if arrived.chars().count() < typed.chars().count()
		&& !typed.contains(arrived)
		&& is_subsequence(arrived, &typed)
	{
		return Verdict::Dropped { arrived: arrived.to_string() };
	}
	Verdict::Unconfirmed(format!(
		"{field} gained {} ({} characters) rather than the typed text",
		quoted(arrived),
		arrived.chars().count()
	))
}

/// How a field shows one run of typed text, read after the run was sent.
#[derive(Debug, PartialEq, Eq)]
pub enum Progress {
	/// The field gained the run.
	Shown,
	/// The field gained less than the run, all of it from the run in order,
	/// or nothing: it has not caught up yet, or it dropped the rest.
	Short,
	/// The field reads some other way, so its text cannot pace typing.
	Other,
}

/// Compares the text of a field `before` and `after` the run `typed` was
/// sent to it, as [`verdict`] compares the whole text.
pub fn progress(typed: &str, before: &str, after: &str) -> Progress {
	let (typed, before, after) = (line_breaks(typed), line_breaks(before), line_breaks(after));
	if shows(&typed, &before, &after) {
		return Progress::Shown;
	}
	let arrived = gained(&before, &after);
	if arrived.chars().count() < typed.chars().count() && is_subsequence(arrived, &typed) {
		Progress::Short
	} else {
		Progress::Other
	}
}

/// Whether `after` holds `typed` where `before` did not: more copies than
/// before is an insertion; the whole text being the typed text is a
/// replaced selection.
fn shows(typed: &str, before: &str, after: &str) -> bool {
	after == typed || after.matches(typed).count() > before.matches(typed).count()
}

/// The error for typed text that `field` dropped part of.
pub fn dropped_message(typed: &str, field: &str, arrived: &str) -> String {
	format!(
		"typed {} characters into {field}, but only {} arrived: {}; the app dropped the rest: \
		 inspect the target before typing again",
		typed.chars().count(),
		arrived.chars().count(),
		quoted(arrived)
	)
}

/// Whether `typed` holds a key that can legitimately leave the field without
/// the text: Return can submit a form or a chat box and clear it, and Tab can
/// move focus.
fn may_leave_field(typed: &str) -> bool {
	typed.contains(['\n', '\t'])
}

/// The part of `after` that differs from `before`: what an insertion at the
/// caret inserted.
fn gained<'a>(before: &str, after: &'a str) -> &'a str {
	let prefix = before
		.chars()
		.zip(after.chars())
		.take_while(|(left, right)| left == right)
		.map(|(character, _)| character.len_utf8())
		.sum::<usize>();
	let suffix = before[prefix..]
		.chars()
		.rev()
		.zip(after[prefix..].chars().rev())
		.take_while(|(left, right)| left == right)
		.map(|(character, _)| character.len_utf8())
		.sum::<usize>();
	&after[prefix..after.len() - suffix]
}

fn is_subsequence(part: &str, whole: &str) -> bool {
	let mut whole = whole.chars();
	part
		.chars()
		.all(|character| whole.any(|candidate| candidate == character))
}

fn quoted(text: &str) -> String {
	if text.chars().count() > QUOTED_CHARS {
		format!("{:?}", format!("{}…", text.chars().take(QUOTED_CHARS - 1).collect::<String>()))
	} else {
		format!("{text:?}")
	}
}

fn line_breaks(text: &str) -> String {
	text.replace("\r\n", "\n").replace('\r', "\n")
}

#[cfg(test)]
mod tests {
	use super::*;

	const FIELD: &str = "the field";

	#[test]
	fn an_insertion_or_a_replaced_selection_confirms() {
		for (typed, before, after) in [
			("abc", "", "abc"),
			("abc", "xy", "xabcy"),
			// Text the field held already needs one more copy.
			("a", "a", "aa"),
			// Select-all then type: the field is the typed text.
			("foo", "foo.txt", "foo"),
			("abc", "abc", "abc"),
			("one\ntwo", "", "one\r\ntwo"),
			("one\ntwo", "", "one\rtwo"),
		] {
			assert_eq!(
				verdict(typed, before, after, FIELD),
				Verdict::Confirmed,
				"{typed:?} into {before:?}"
			);
		}
	}

	#[test]
	fn characters_missing_from_inside_the_text_are_dropped() {
		// Windows 11 Notepad keeps a scattered few of fast synthetic characters.
		assert_eq!(verdict("t000-ab t001-ab", "", "t0-b t1", FIELD), Verdict::Dropped {
			arrived: "t0-b t1".to_string(),
		});
		assert_eq!(verdict("hello", "<>", "<hl>", FIELD), Verdict::Dropped {
			arrived: "hl".to_string(),
		});
		assert_eq!(verdict("é😀x", "", "éx", FIELD), Verdict::Dropped {
			arrived: "éx".to_string(),
		});
	}

	#[test]
	fn other_misses_are_unconfirmed_not_failures() {
		for (typed, before, after) in [
			// Reformatted: upper-cased, smart quotes, grouped digits.
			("hello", "", "HELLO"),
			("it's", "", "it’s"),
			("1000", "", "1,000"),
			// Unchanged: a key sink that never holds the text, a read-only list.
			("hello", "same", "same"),
			// A contiguous part: a length limit or an editor showing a window of
			// the line.
			("hello world", "", "hello"),
			("hello world", "", "world"),
			// Return can submit and clear the field.
			("query\n", "", ""),
			("a\tb", "", "a"),
		] {
			let result = verdict(typed, before, after, FIELD);
			assert!(matches!(result, Verdict::Unconfirmed(_)), "{typed:?} -> {after:?}: {result:?}");
		}
	}

	#[test]
	fn unconfirmed_reasons_name_the_field_and_what_it_gained() {
		let Verdict::Unconfirmed(reason) = verdict("hello", "", "HELLO", "window 1's focused edit")
		else {
			panic!("expected unconfirmed");
		};
		assert!(reason.starts_with("window 1's focused edit"), "{reason}");
		assert!(reason.contains("\"HELLO\" (5 characters)"), "{reason}");
		let Verdict::Unconfirmed(reason) = verdict("query\n", "", "", FIELD) else {
			panic!("expected unconfirmed");
		};
		assert!(reason.contains("Return or Tab"), "{reason}");
	}

	#[test]
	fn the_dropped_message_counts_and_quotes_what_arrived() {
		let message = dropped_message("hello", "window 1's focused document", "hl");
		assert!(message.contains("typed 5 characters into window 1's focused document"), "{message}");
		assert!(message.contains("only 2 arrived: \"hl\""), "{message}");
		assert!(message.contains("inspect the target before typing again"), "{message}");
		let long = "x".repeat(300);
		let message = dropped_message(&long, FIELD, &long);
		assert!(message.contains(&format!("\"{}…\"", "x".repeat(QUOTED_CHARS - 1))), "{message}");
	}

	#[test]
	fn a_run_is_shown_short_or_unusable_for_pacing() {
		assert_eq!(progress("ab ", "x", "xab "), Progress::Shown);
		assert_eq!(progress("ab ", "foo", "ab "), Progress::Shown);
		assert_eq!(progress("c\n", "ab ", "ab c\r\n"), Progress::Shown);
		// Not caught up yet, or dropped part or all of the run.
		assert_eq!(progress("abc ", "x", "xab"), Progress::Short);
		assert_eq!(progress("abc ", "x", "xc "), Progress::Short);
		assert_eq!(progress("abc ", "x", "x"), Progress::Short);
		// Reformatted, or other text than the run.
		assert_eq!(progress("abc ", "x", "xABC "), Progress::Other);
		assert_eq!(progress("abc ", "x", "xabd "), Progress::Other);
	}
}
