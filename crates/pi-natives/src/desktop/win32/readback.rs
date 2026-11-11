//! Pure checks of takeover-typed text against what the focused field reads
//! back through UI Automation after typing.
//!
//! This module has no Windows imports, so the host test suite exercises the
//! verdicts and their wording on every platform.

use std::time::Duration;

use super::delivery;

/// Characters of field text a message quotes.
const QUOTED_CHARS: usize = 120;

/// What the focused field's text after typing says about the typed text.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
	/// The field gained the typed text.
	Confirmed,
	/// The field gained only `arrived`: some of the typed characters, in
	/// order, with others missing from between them, and some character
	/// kept at one place and lost at another. That is how a control that
	/// drops fast synthetic input loses text; a field that filters a
	/// character (digits only, no dashes) removes every copy of it.
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
		&& partly_kept(arrived, &typed)
	{
		return Verdict::Dropped { arrived: arrived.to_string() };
	}
	Verdict::Unconfirmed(format!(
		"{field} gained {} ({} characters) rather than the typed text ({} characters)",
		quoted(arrived),
		arrived.chars().count(),
		typed.chars().count()
	))
}

/// Whether some character of `typed` arrived fewer times than it was typed,
/// but at least once.
fn partly_kept(arrived: &str, typed: &str) -> bool {
	typed.chars().any(|character| {
		let kept = arrived.matches(character).count();
		kept > 0 && kept < typed.matches(character).count()
	})
}

/// How a field shows one run of typed text, read after the run was sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Progress {
	/// The field gained the run.
	Shown,
	/// The field gained less than the run, all of it from the run in order,
	/// or nothing: it has not caught up yet, or it dropped the rest.
	Short,
	/// The field reads some other way: it reformatted or autocorrected the
	/// run, or shows something else.
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

/// Whether `after` holds `typed` where `before` did not: the field changed,
/// gained at least as many characters as were typed, and holds one more
/// copy of them, or it replaced a selection and its whole text is the typed
/// text. Text the field held already cannot stand in for keys that did not
/// arrive: `"ha"` that gained one `"ha"` of a typed `"haha"` does not show
/// it.
fn shows(typed: &str, before: &str, after: &str) -> bool {
	after != before
		&& ((replaced(before, after) && after == typed)
			|| (gained(before, after).chars().count() >= typed.chars().count()
				&& after.matches(typed).count() > before.matches(typed).count()))
}

/// Pieces in a row after which the field's text did not change at all
/// before pacing stops: the keys go somewhere else.
const QUIET_PIECES: u8 = 2;

/// Longest one UI Automation call reading a field back may take: the
/// connection and transaction timeouts of the client typing reads through,
/// so a provider that does not answer (a hung app, Settings while it digests
/// a burst of keys) fails the read instead of holding the call. One read is
/// one call for a `ValuePattern` and two for a `TextPattern`.
pub const READ_TIMEOUT: Duration = Duration::from_millis(250);

/// How long typing waits on the field it reads back.
#[derive(Clone, Copy, Debug)]
pub struct Waits {
	/// Longest wait for a field to show one piece of typed text.
	pub run:           Duration,
	/// A field whose text has not changed for this long after a piece has
	/// taken what it will of it.
	pub run_still:     Duration,
	/// Time between reads of a field that does not show a piece yet.
	pub run_poll:      Duration,
	/// Pacing time allowed per typed character ([`Waits::pace_budget`]).
	pub pace_per_char: Duration,
	/// Least and most pacing time allowed one call.
	pub pace_min:      Duration,
	pub pace_max:      Duration,
	/// Longest wait after the last key for the field to show the text.
	pub check:         Duration,
	/// The check ends once the field's text has not changed for this long.
	pub check_still:   Duration,
	/// Time between reads of a field that does not show the text yet.
	pub check_poll:    Duration,
}

impl Waits {
	/// The waits of takeover typing. Windows 11 Notepad shows 2,000 paced
	/// characters in about 8 s (4 ms each); a field that redraws more slowly
	/// than the budget allows gets the rest unpaced.
	pub const TYPING: Self = Self {
		run:           Duration::from_secs(1),
		run_still:     Duration::from_millis(60),
		run_poll:      Duration::from_millis(2),
		pace_per_char: Duration::from_millis(10),
		pace_min:      Duration::from_secs(1),
		pace_max:      Duration::from_secs(30),
		check:         Duration::from_secs(1),
		check_still:   Duration::from_millis(300),
		check_poll:    Duration::from_millis(25),
	};

	/// Longest a call typing `chars` characters paces itself before sending
	/// the rest unpaced, counted from its first key.
	pub fn pace_budget(&self, chars: usize) -> Duration {
		self
			.pace_per_char
			.saturating_mul(u32::try_from(chars).unwrap_or(u32::MAX))
			.clamp(self.pace_min, self.pace_max)
	}
}

/// A field typed text is read back from.
pub trait Field {
	/// Its text now; `None` when the read failed, which a provider that does
	/// not answer within [`READ_TIMEOUT`] makes it.
	fn read(&self) -> Option<String>;
}

/// The time typing waits by.
pub trait Clock {
	/// Time since a fixed start.
	fn now(&self) -> Duration;
	fn sleep(&self, duration: Duration);
}

/// How takeover typing paces itself by reading the field back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pace {
	/// One call per word, each once the field shows the one before.
	Words,
	/// One call per character, each once the field shows the one before:
	/// the field came up short on a word. A word shown whole this way goes
	/// back to [`Pace::Words`].
	Characters,
	/// No waits: no field to read, one whose text stopped changing or could
	/// not be read, or past the pacing budget.
	Off,
}

/// The pace of one typing call.
#[derive(Debug)]
pub struct Pacer {
	pub pace: Pace,
	quiet:    u8,
	budget:   Duration,
}

impl Pacer {
	pub const fn new(readable: bool, budget: Duration) -> Self {
		Self { pace: if readable { Pace::Words } else { Pace::Off }, quiet: 0, budget }
	}

	/// Updates the pace after a piece went out: `progress` is how the field
	/// showed it (`None`: the field could not be read), `changed` whether
	/// the field's text changed at all while waiting for it, `run_end`
	/// whether the piece ended its word. A field that reads some other way
	/// (autocorrect, a suggestion) keeps its pace: the wait for it to stop
	/// changing still paces it. Past the budget of `paced` time pacing stops.
	pub fn after(
		&mut self,
		progress: Option<Progress>,
		changed: bool,
		run_end: bool,
		paced: Duration,
	) {
		let Some(progress) = progress.filter(|_| paced < self.budget) else {
			self.pace = Pace::Off;
			return;
		};
		if progress != Progress::Shown && !changed {
			self.quiet += 1;
			if self.quiet >= QUIET_PIECES {
				self.pace = Pace::Off;
				return;
			}
		} else {
			self.quiet = 0;
		}
		self.pace = match (self.pace, progress) {
			(Pace::Words, Progress::Short) => Pace::Characters,
			(Pace::Characters, Progress::Shown) if run_end => Pace::Words,
			(pace, _) => pace,
		};
	}
}

/// Sends `text` one [`delivery::word_runs`] run per `send` call. With
/// `field`, which read `before` when typing began, each piece waits for the
/// field to show it before the next goes ([`Pacer`]). `check` runs between
/// reads and its error stops typing. Returns the field's text when last
/// read, if a read while pacing succeeded.
///
/// Pacing adds at most [`Waits::pace_budget`], plus the wait for the piece
/// in flight when the budget ran out (`waits.run` and one read, 2 ×
/// [`READ_TIMEOUT`]), to the call.
pub fn send_paced<F: Field, E>(
	text: &str,
	field: Option<(&F, &str)>,
	clock: &impl Clock,
	waits: &Waits,
	mut send: impl FnMut(&str) -> Result<(), E>,
	mut check: impl FnMut() -> Result<(), E>,
) -> Result<Option<String>, E> {
	let waits = &diag::waits(*waits);
	let (keep_words, keep_lag) = diag::keepup();
	let mut kept = 0u32;
	let budget = std::env::var("WTB_BUDGET_MS")
		.ok()
		.and_then(|value| value.parse().ok())
		.map_or_else(|| waits.pace_budget(text.chars().count()), Duration::from_millis);
	let mut pacer = Pacer::new(field.is_some(), budget);
	let start = clock.now();
	let mut shown = field.map(|(_, before)| before.to_string());
	let mut last = None;
	for run in delivery::word_runs(text) {
		let mut rest = run;
		while !rest.is_empty() {
			let piece = if pacer.pace == Pace::Characters {
				xutf::graphemes_str(rest).next().unwrap_or(rest)
			} else {
				rest
			};
			rest = &rest[piece.len()..];
			send(piece)?;
			if let (Some((field, _)), Some(before)) = (field, shown.as_mut())
				&& pacer.pace != Pace::Off
			{
				let sent = clock.now();
				let pace = pacer.pace;
				let (progress, changed) = await_piece(field, clock, waits, piece, before, &mut check)?;
				let lag = clock.now().saturating_sub(sent);
				if progress.is_some() {
					last = Some(before.clone());
				}
				pacer.after(progress, changed, rest.is_empty(), clock.now().saturating_sub(start));
				if pace == Pace::Words && progress == Some(Progress::Shown) && lag <= keep_lag {
					kept += 1;
				} else {
					kept = 0;
				}
				if keep_words > 0 && kept >= keep_words && pacer.pace == Pace::Words {
					pacer.pace = Pace::Off;
					diag::trace("keepup_off");
				}
				diag::trace(&format!(
					"piece len={} at_us={} lag_us={} progress={progress:?} changed={changed} pace={:?}",
					piece.chars().count(),
					sent.saturating_sub(start).as_micros(),
					lag.as_micros(),
					pacer.pace
				));
			}
		}
	}
	Ok(last)
}

/// Waits until `field`, which read `before` when `piece` was sent, shows
/// it, stops changing short of it, or `waits.run` passes; `before` becomes
/// the last read. Returns how the field shows the piece (`None`: it could
/// not be read) and whether its text changed. No read starts after
/// `waits.run`, so the wait ends within it plus one read.
fn await_piece<E>(
	field: &impl Field,
	clock: &impl Clock,
	waits: &Waits,
	piece: &str,
	before: &mut String,
	check: &mut impl FnMut() -> Result<(), E>,
) -> Result<(Option<Progress>, bool), E> {
	let start = clock.now();
	let mut changed = start;
	let mut last: Option<String> = None;
	let mut reads = 0u32;
	let mut slowest = Duration::ZERO;
	loop {
		let read_at = clock.now();
		let read = field.read();
		reads += 1;
		slowest = slowest.max(clock.now().saturating_sub(read_at));
		let Some(now) = read else {
			diag::trace(&format!("await reads={reads} slowest_us={} failed", slowest.as_micros()));
			return Ok((None, false));
		};
		let progress = progress(piece, before, &now);
		let still = last.as_deref() == Some(now.as_str());
		if !still {
			changed = clock.now();
		}
		if progress == Progress::Shown
			|| (still && clock.now().saturating_sub(changed) >= waits.run_still)
			|| clock.now().saturating_sub(start) >= waits.run
		{
			let moved = now != *before;
			*before = now;
			diag::trace(&format!("await reads={reads} slowest_us={}", slowest.as_micros()));
			return Ok((Some(progress), moved));
		}
		last = Some(now);
		check()?;
		clock.sleep(waits.run_poll);
	}
}

/// What typing sent and saw, for [`check_typed`].
pub struct Sent<'a> {
	/// The typed text.
	pub typed:  &'a str,
	/// The field's text when typing began.
	pub before: &'a str,
	/// Its text when last read while pacing.
	pub last:   Option<String>,
	/// Why the target was not seen reading all the keys, if it was not.
	pub unread: Option<String>,
}

/// Checks that `field` (what messages call it) gained `sent.typed`. Reads
/// until the field shows the text, its text stops changing for
/// `waits.check_still`, `waits.check` passes, a read fails, or `cancelled`
/// says so; no read starts after `waits.check`, so the check ends within it
/// plus one read (2 × [`READ_TIMEOUT`]). The verdict is that of the last
/// read, and a failed read leaves the call unconfirmed, saying what the
/// field last read. With `sent.unread`, anything short of the text is
/// unconfirmed with that reason first, never [`Verdict::Dropped`]: keys
/// still queued may yet arrive.
pub fn check_typed(
	field: &impl Field,
	name: &str,
	sent: Sent<'_>,
	clock: &impl Clock,
	waits: &Waits,
	cancelled: impl FnMut() -> bool,
) -> Verdict {
	let Sent { typed, before, last, unread } = sent;
	match (read_until_settled(field, name, typed, before, last, (clock, waits), cancelled), unread) {
		(Verdict::Confirmed, _) => Verdict::Confirmed,
		(verdict, None) => verdict,
		(Verdict::Dropped { arrived }, Some(unread)) => {
			Verdict::Unconfirmed(format!("{unread}; {}", dropped_message(typed, name, &arrived)))
		},
		(Verdict::Unconfirmed(reason), Some(unread)) => {
			Verdict::Unconfirmed(format!("{unread}; {reason}"))
		},
	}
}

/// [`check_typed`]'s reads.
fn read_until_settled(
	field: &impl Field,
	name: &str,
	typed: &str,
	before: &str,
	last: Option<String>,
	(clock, waits): (&impl Clock, &Waits),
	mut cancelled: impl FnMut() -> bool,
) -> Verdict {
	let waits = &diag::waits(*waits);
	let start = clock.now();
	let mut seen = last;
	let mut changed = start;
	let mut reads = 0u32;
	loop {
		reads += 1;
		let read_at = clock.now();
		let read = field.read();
		diag::trace(&format!(
			"check read={reads} us={} ok={} chars={}",
			clock.now().saturating_sub(read_at).as_micros(),
			read.is_some(),
			read.as_ref().map_or(0, |text| text.chars().count())
		));
		let Some(now) = read else {
			let last = seen.map(|seen| match verdict(typed, before, &seen, name) {
				Verdict::Confirmed => "it showed the text".to_string(),
				Verdict::Dropped { arrived } => dropped_message(typed, name, &arrived),
				Verdict::Unconfirmed(reason) => reason,
			});
			return Verdict::Unconfirmed(match last {
				Some(last) => format!(
					"reading {name} back failed or took longer than {} ms; when last read, {last}",
					READ_TIMEOUT.as_millis()
				),
				None => format!(
					"reading {name} back failed or took longer than {} ms",
					READ_TIMEOUT.as_millis()
				),
			});
		};
		let result = verdict(typed, before, &now, name);
		if result == Verdict::Confirmed {
			return result;
		}
		if seen.as_deref() != Some(now.as_str()) {
			changed = clock.now();
			seen = Some(now);
		}
		let at = clock.now();
		if at.saturating_sub(start) >= waits.check || at.saturating_sub(changed) >= waits.check_still
		{
			return result;
		}
		// The text is out, so a cancel ends the wait without failing the
		// call.
		if cancelled() {
			return Verdict::Unconfirmed(format!(
				"the call was cancelled before {name} showed the text"
			));
		}
		clock.sleep(waits.check_poll);
	}
}

/// WinTypeBound diagnostics: env overrides and a trace file. Not for merge.
pub mod diag {
	use std::{io::Write as _, time::Duration};

	pub fn trace(line: &str) {
		if let Ok(path) = std::env::var("WTB_TRACE")
			&& let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path)
		{
			let _ = writeln!(file, "{line}");
		}
	}

	fn ms(key: &str) -> Option<Duration> {
		std::env::var(key).ok()?.parse::<u64>().ok().map(Duration::from_millis)
	}

	pub fn waits(mut waits: super::Waits) -> super::Waits {
		if let Some(value) = ms("WTB_CHECK_MS") {
			waits.check = value;
		}
		if let Some(value) = ms("WTB_CHECK_STILL_MS") {
			waits.check_still = value;
		}
		waits
	}

	/// `WTB_KEEPUP=K:LAG_US`: pacing stops after K words in a row shown
	/// within LAG_US of being sent.
	pub fn keepup() -> (u32, Duration) {
		std::env::var("WTB_KEEPUP")
			.ok()
			.and_then(|value| {
				let (words, lag) = value.split_once(':')?;
				Some((words.parse().ok()?, Duration::from_micros(lag.parse().ok()?)))
			})
			.unwrap_or((0, Duration::ZERO))
	}
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
	let (prefix, suffix) = common_ends(before, after);
	&after[prefix..after.len() - suffix]
}

/// Whether `after` lost some of `before`: typing replaced a selection.
fn replaced(before: &str, after: &str) -> bool {
	let (prefix, suffix) = common_ends(before, after);
	prefix + suffix < before.len()
}

/// Byte lengths of the longest common prefix of `before` and `after`, and of
/// the longest common suffix of what follows it.
fn common_ends(before: &str, after: &str) -> (usize, usize) {
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
	(prefix, suffix)
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
	use std::{
		cell::{Cell, RefCell},
		fmt::Write as _,
	};

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
	fn text_the_field_held_never_stands_in_for_keys_that_did_not_arrive() {
		for (typed, before, after) in [
			// Nothing arrived into a field that already read as typed.
			("abc", "abc", "abc"),
			// What arrived plus what was there spells the typed text.
			("haha", "ha", "haha"),
			("aa", "xa", "xaa"),
			("http://example.com", "http://", "http://example.com"),
		] {
			let result = verdict(typed, before, after, FIELD);
			assert!(
				matches!(result, Verdict::Unconfirmed(_)),
				"{typed:?} into {before:?}: {result:?}"
			);
		}
		assert_eq!(progress("ab ", "ab ", "ab "), Progress::Short);
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
			// Filtered: every copy of a character the field refuses is gone.
			("555-123-4567", "", "5551234567"),
			("1,234", "", "1234"),
			("é😀x", "", "éx"),
			// Return can submit and clear the field.
			("query\n", "", ""),
			("a\tb", "", "a"),
		] {
			let result = verdict(typed, before, after, FIELD);
			assert!(matches!(result, Verdict::Unconfirmed(_)), "{typed:?} -> {after:?}: {result:?}");
		}
		let Verdict::Unconfirmed(reason) = verdict("hello", "", "HELLO", "window 1's focused edit")
		else {
			panic!("expected unconfirmed");
		};
		assert!(reason.starts_with("window 1's focused edit"), "{reason}");
		assert!(
			reason.contains("(5 characters) rather than the typed text (5 characters)"),
			"{reason}"
		);
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

	#[test]
	fn pacing_slows_on_a_short_word_and_stops_when_the_field_goes_quiet() {
		let budget = Waits::TYPING.pace_max;
		let mut pacer = Pacer::new(true, budget);
		pacer.after(Some(Progress::Shown), true, true, Duration::ZERO);
		assert_eq!(pacer.pace, Pace::Words);
		// Autocorrect reads otherwise but the field changed: keep pacing.
		pacer.after(Some(Progress::Other), true, true, Duration::ZERO);
		assert_eq!(pacer.pace, Pace::Words);
		pacer.after(Some(Progress::Short), true, true, Duration::ZERO);
		assert_eq!(pacer.pace, Pace::Characters);
		pacer.after(Some(Progress::Shown), true, false, Duration::ZERO);
		assert_eq!(pacer.pace, Pace::Characters);
		pacer.after(Some(Progress::Shown), true, true, Duration::ZERO);
		assert_eq!(pacer.pace, Pace::Words);
		// One quiet piece slows down; two in a row stop the waits.
		pacer.after(Some(Progress::Short), false, true, Duration::ZERO);
		assert_eq!(pacer.pace, Pace::Characters);
		pacer.after(Some(Progress::Short), false, false, Duration::ZERO);
		assert_eq!(pacer.pace, Pace::Off);

		let mut pacer = Pacer::new(true, budget);
		pacer.after(None, true, true, Duration::ZERO);
		assert_eq!(pacer.pace, Pace::Off);
		assert_eq!(Pacer::new(false, budget).pace, Pace::Off);

		let mut pacer = Pacer::new(true, budget);
		pacer.after(Some(Progress::Shown), true, true, budget);
		assert_eq!(pacer.pace, Pace::Off);
	}

	/// Time that passes only when the code under test sleeps or a fake field
	/// takes time to answer.
	#[derive(Default)]
	struct FakeClock(Cell<Duration>);

	impl Clock for FakeClock {
		fn now(&self) -> Duration {
			self.0.get()
		}

		fn sleep(&self, duration: Duration) {
			self.0.set(self.0.get() + duration);
		}
	}

	/// A field whose provider answers after `cost` with `show` applied to the
	/// text sent so far and the time, or not at all (`None`).
	struct FakeField<'a> {
		clock: &'a FakeClock,
		sent:  RefCell<String>,
		cost:  Duration,
		show:  fn(&str, Duration) -> Option<String>,
	}

	impl<'a> FakeField<'a> {
		fn new(
			clock: &'a FakeClock,
			cost: Duration,
			show: fn(&str, Duration) -> Option<String>,
		) -> Self {
			Self { clock, sent: RefCell::default(), cost, show }
		}

		/// Types `typed` through [`send_paced`] and [`check_typed`]; returns
		/// the verdict and the time both took.
		fn type_text(&self, typed: &str) -> (Verdict, Duration) {
			let start = self.clock.now();
			let last = send_paced(
				typed,
				Some((self, "")),
				self.clock,
				&Waits::TYPING,
				|piece| {
					self.sent.borrow_mut().push_str(piece);
					Ok::<_, ()>(())
				},
				|| Ok(()),
			)
			.unwrap();
			let sent = Sent { typed, before: "", last, unread: None };
			let verdict = check_typed(self, FIELD, sent, self.clock, &Waits::TYPING, || false);
			(verdict, self.clock.now().saturating_sub(start))
		}
	}

	impl Field for FakeField<'_> {
		fn read(&self) -> Option<String> {
			self.clock.sleep(self.cost);
			(self.show)(&self.sent.borrow(), self.clock.now())
		}
	}

	fn words(chars: usize) -> String {
		let mut text = String::new();
		for word in 0.. {
			if text.len() >= chars {
				break;
			}
			let _ = write!(text, "t{word:03}-ab ");
		}
		text.truncate(chars);
		text
	}

	/// Longest one read of a `TextPattern` field can take: two calls.
	const READ: Duration = Duration::from_millis(2 * READ_TIMEOUT.as_millis() as u64);

	#[test]
	fn a_provider_that_never_answers_ends_typing_within_two_reads() {
		let clock = FakeClock::default();
		let field = FakeField::new(&clock, READ, |_, _| None);
		let (verdict, took) = field.type_text(&words(2000));
		// One read stops pacing and one ends the check.
		assert_eq!(took, 2 * READ);
		let Verdict::Unconfirmed(reason) = verdict else {
			panic!("expected unconfirmed: {verdict:?}");
		};
		assert!(reason.starts_with("reading the field back failed or took longer than"), "{reason}");
		assert_eq!(field.sent.borrow().as_str(), words(2000));
	}

	#[test]
	fn a_provider_that_stops_answering_reports_what_it_last_read() {
		let clock = FakeClock::default();
		// Answers while it shows fewer than 100 characters, then hangs.
		let field = FakeField::new(&clock, Duration::from_millis(1), |sent, _| {
			(sent.len() < 100).then(|| sent.to_string())
		});
		let (verdict, took) = field.type_text(&words(240));
		let Verdict::Unconfirmed(reason) = verdict else {
			panic!("expected unconfirmed: {verdict:?}");
		};
		assert!(
			reason.starts_with(
				"reading the field back failed or took longer than 250 ms; when last read, the field \
				 gained \"t000-ab"
			),
			"{reason}"
		);
		assert!(reason.contains("rather than the typed text (240 characters)"), "{reason}");
		assert!(took < Duration::from_millis(500), "{took:?}");
	}

	#[test]
	fn a_slow_provider_is_held_to_the_pacing_budget_and_the_check() {
		let clock = FakeClock::default();
		// Every read takes just under the limit, and the field shows one
		// character per 20 ms: it keeps every key, too slowly to finish.
		let field =
			FakeField::new(&clock, READ.saturating_sub(Duration::from_millis(1)), |sent, now| {
				Some(sent.chars().take((now.as_millis() / 20) as usize).collect())
			});
		let (verdict, took) = field.type_text(&words(2000));
		assert!(matches!(verdict, Verdict::Unconfirmed(_)), "{verdict:?}");
		let waits = Waits::TYPING;
		// Pacing ran into its budget, and the check into its limit.
		let budget = waits.pace_budget(2000);
		assert_eq!(budget, Duration::from_secs(20));
		assert_eq!(waits.pace_budget(1), waits.pace_min);
		assert_eq!(waits.pace_budget(100_000), waits.pace_max);
		assert!(took >= budget + waits.check, "{took:?}");
		assert!(took <= budget + waits.check + 2 * READ, "{took:?}");
	}

	#[test]
	fn a_field_that_stops_advancing_ends_the_check_once_still() {
		let clock = FakeClock::default();
		// Keeps the first word and nothing after it.
		let field = FakeField::new(&clock, Duration::from_millis(1), |sent, _| {
			Some(sent.chars().take(8).collect())
		});
		let (verdict, took) = field.type_text(&words(240));
		let Verdict::Unconfirmed(reason) = verdict else {
			panic!("expected unconfirmed: {verdict:?}");
		};
		assert!(
			reason.contains(
				"gained \"t000-ab \" (8 characters) rather than the typed text (240 characters)"
			),
			"{reason}"
		);
		// Two quiet pieces stop pacing; the check ends once the text has been
		// still for `check_still`.
		assert!(took < Duration::from_millis(600), "{took:?}");
	}

	#[test]
	fn a_field_that_trims_a_trailing_space_is_never_confirmed() {
		let clock = FakeClock::default();
		// Settings' search box drops a trailing space.
		let field = FakeField::new(&clock, Duration::from_millis(1), |sent, _| {
			Some(sent.trim_end().to_string())
		});
		let typed = words(240);
		assert!(typed.ends_with(' '));
		let (verdict, took) = field.type_text(&typed);
		let Verdict::Unconfirmed(reason) = verdict else {
			panic!("expected unconfirmed: {verdict:?}");
		};
		assert!(
			reason.contains("(239 characters) rather than the typed text (240 characters)"),
			"{reason}"
		);
		let waits = Waits::TYPING;
		assert!(took <= waits.pace_budget(240) + waits.check + 2 * READ, "{took:?}");
	}

	#[test]
	fn a_field_that_keeps_up_is_confirmed_at_the_first_check() {
		let clock = FakeClock::default();
		let field =
			FakeField::new(&clock, Duration::from_millis(1), |sent, _| Some(sent.to_string()));
		let typed = words(240);
		let (verdict, took) = field.type_text(&typed);
		assert_eq!(verdict, Verdict::Confirmed);
		// One read per word and one to check.
		let reads = typed.split_inclusive(' ').count() as u32 + 1;
		assert_eq!(took, reads * Duration::from_millis(1));
	}

	#[test]
	fn keys_the_target_was_not_seen_reading_are_never_called_dropped() {
		let clock = FakeClock::default();
		// Keeps a scattered few characters, as Notepad does.
		let field =
			FakeField::new(&clock, Duration::from_millis(1), |_, _| Some("t0-b t1".to_string()));
		let sent = Sent {
			typed:  "t000-ab t001-ab",
			before: "",
			last:   None,
			unread: Some("the target had not read all the typed text".to_string()),
		};
		let Verdict::Unconfirmed(reason) =
			check_typed(&field, FIELD, sent, &clock, &Waits::TYPING, || false)
		else {
			panic!("expected unconfirmed");
		};
		assert!(reason.starts_with("the target had not read all the typed text; "), "{reason}");
		assert!(reason.contains("only 7 arrived"), "{reason}");
	}

	#[test]
	fn a_cancel_ends_the_check_unconfirmed() {
		let clock = FakeClock::default();
		let field = FakeField::new(&clock, Duration::from_millis(1), |_, _| Some("ab".to_string()));
		let sent = Sent { typed: "abc", before: "", last: None, unread: None };
		let Verdict::Unconfirmed(reason) =
			check_typed(&field, FIELD, sent, &clock, &Waits::TYPING, || true)
		else {
			panic!("expected unconfirmed");
		};
		assert!(reason.contains("cancelled"), "{reason}");
		assert!(clock.now() < Waits::TYPING.check_still, "{:?}", clock.now());
	}

	#[test]
	fn a_failed_send_or_cancel_stops_typing() {
		let clock = FakeClock::default();
		let field = FakeField::new(&clock, Duration::from_millis(1), |_, _| Some(String::new()));
		let mut sent = 0;
		let result = send_paced(
			&words(240),
			Some((&field, "")),
			&clock,
			&Waits::TYPING,
			|_| {
				sent += 1;
				if sent == 3 {
					Err("send failed")
				} else {
					Ok(())
				}
			},
			|| Ok(()),
		);
		assert_eq!(result, Err("send failed"));
		assert_eq!(sent, 3);
		// The field never shows anything: the cancel check between reads stops
		// the first wait.
		let mut sent = 0;
		let result = send_paced(
			&words(240),
			Some((&field, "")),
			&clock,
			&Waits::TYPING,
			|_| {
				sent += 1;
				Ok(())
			},
			|| Err("cancelled"),
		);
		assert_eq!(result, Err("cancelled"));
		assert_eq!(sent, 1);
	}
}
