//! Reading an element's formatted text as Markdown.
//!
//! `AXValue` of a text view is plain text: bold, italic, struck-out text and a
//! link's address are gone. `AXAttributedStringForRange` keeps them as run
//! attributes (`AXFont`, `AXStrikethrough`, `AXLink`), which this module reads
//! and renders as Markdown. `AppKit` lays out a list item as `\t•\t` or
//! `\t1.\t` in the text itself; those become Markdown list items.

use std::{
	fmt::Write as _,
	ptr::{self, NonNull},
};

use objc2::rc::autoreleasepool;
use objc2_app_kit::{NSFont, NSFontDescriptorSymbolicTraits};
use objc2_application_services::{AXError, AXUIElement, AXValue, AXValueType};
use objc2_core_foundation::{
	CFAttributedString, CFBoolean, CFDictionary, CFIndex, CFNumber, CFRange, CFRetained, CFString,
	CFType, CFURL,
};
use objc2_foundation::NSString;

use super::{
	CoreResult, DesktopError, ax_error, copy_attribute_result, copy_held_attribute, copy_string,
};

/// How many times a text that changes while it is read is read again.
const READ_ATTEMPTS: usize = 3;

/// The styles Markdown can show.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct Style {
	pub(super) bold:    bool,
	pub(super) italic:  bool,
	pub(super) strike:  bool,
	pub(super) link:    Option<String>,
	/// `AXHeadingLevel`, 1-6 on a web page's heading text; 0 elsewhere.
	pub(super) heading: u8,
}

/// One run of text in one style.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct Span {
	pub(super) text:  String,
	pub(super) style: Style,
}

/// `element`'s whole text as Markdown.
pub(super) fn markdown(element: &AXUIElement) -> CoreResult<String> {
	ensure_readable(copy_attribute_result(element, "AXSubrole"))?;
	// The font lookups run on the session thread, which has no pool of its own.
	autoreleasepool(|_| Ok(to_markdown(&spans(element)?)))
}

/// A secure text field's text is never read, masked or not, and neither is the
/// text of an element whose subrole could not be read.
fn ensure_readable(subrole: Result<Option<CFRetained<CFType>>, AXError>) -> CoreResult<()> {
	let subrole = match subrole {
		Ok(subrole) => subrole
			.and_then(|value| value.downcast::<CFString>().ok())
			.map(|value| value.to_string()),
		Err(error) if error == AXError::NoValue || error == AXError::AttributeUnsupported => None,
		Err(error) => {
			return Err(ax_error(
				error,
				"reading the element's subrole failed, so its text is not read: it may be a secure \
				 text field",
			));
		},
	};
	if subrole.as_deref() == Some("AXSecureTextField") {
		return Err(DesktopError::ax_failed("a secure text field's text is never read"));
	}
	Ok(())
}

fn spans(element: &AXUIElement) -> CoreResult<Vec<Span>> {
	let length = || {
		text_length(copy_held_attribute(element, "AXNumberOfCharacters")?, || {
			copy_held_attribute(element, "AXValue")
		})
	};
	let text = read_whole(length, |length| attributed(element, length))?
		.ok_or_else(|| no_formatted_text(element))?;
	read_spans(&text)
}

/// Reads the text at its `length`, again when the length changed during the
/// read or the read came back short, so an edit between the two calls never
/// passes for the whole text. `WebKit`'s attributed text carries list markers
/// its count leaves out, so a longer read is whole.
fn read_whole<T>(
	mut length: impl FnMut() -> CoreResult<Option<CFIndex>>,
	mut read: impl FnMut(CFIndex) -> CoreResult<(T, CFIndex)>,
) -> CoreResult<Option<T>> {
	for _ in 0..READ_ATTEMPTS {
		let Some(before) = length()? else {
			return Ok(None);
		};
		let (text, read_length) = read(before)?;
		if read_length >= before && length()? == Some(before) {
			return Ok(Some(text));
		}
	}
	Err(DesktopError::ax_failed(
		"the text kept changing while it was read; read it again once it settles",
	))
}

/// `AXAttributedStringForRange` over the first `length` characters, and the
/// length of what came back.
fn attributed(
	element: &AXUIElement,
	length: CFIndex,
) -> CoreResult<(CFRetained<CFAttributedString>, CFIndex)> {
	let mut range = CFRange { location: 0, length };
	// SAFETY: `range` is a live CFRange matching the requested AXValue type.
	let parameter = unsafe { AXValue::new(AXValueType::CFRange, NonNull::from(&mut range).cast()) }
		.ok_or_else(|| DesktopError::ax_failed("creating the text range failed"))?;
	let attribute = CFString::from_static_str("AXAttributedStringForRange");
	let mut output: *const CFType = ptr::null();
	// SAFETY: The element, attribute and range outlive the synchronous call;
	// `output` receives a +1 CF object on success.
	let error = unsafe {
		element.copy_parameterized_attribute_value(&attribute, &parameter, NonNull::from(&mut output))
	};
	if [AXError::NoValue, AXError::ParameterizedAttributeUnsupported, AXError::AttributeUnsupported]
		.contains(&error)
	{
		return Err(no_formatted_text(element));
	}
	if error != AXError::Success {
		return Err(ax_error(error, "reading the element's formatted text failed"));
	}
	let text = NonNull::new(output.cast_mut())
		// SAFETY: A successful copy returned this object at +1.
		.map(|pointer| unsafe { CFRetained::<CFType>::from_raw(pointer) })
		.and_then(|value| value.downcast::<CFAttributedString>().ok())
		.ok_or_else(|| no_formatted_text(element))?;
	let read_length = text.length();
	Ok((text, read_length))
}

/// The text's length in UTF-16 units: `AXNumberOfCharacters`, else the length
/// of `AXValue`. A destroyed element fails either read as a stale ref.
fn text_length(
	count: Option<CFRetained<CFType>>,
	value: impl FnOnce() -> CoreResult<Option<CFRetained<CFType>>>,
) -> CoreResult<Option<CFIndex>> {
	if let Some(count) = count
		.and_then(|count| count.downcast::<CFNumber>().ok())
		.and_then(|count| count.as_i64())
	{
		return Ok(Some(count as CFIndex));
	}
	Ok(value()?
		.and_then(|value| value.downcast::<CFString>().ok())
		.map(|value| value.to_string().encode_utf16().count() as CFIndex))
}

fn no_formatted_text(element: &AXUIElement) -> DesktopError {
	let role = copy_string(element, "AXRole").unwrap_or_default();
	DesktopError::ax_failed(format!(
		"this {role} exposes no formatted text; read value() for its plain text (a web page shows \
		 headings, links and lists as elements in ax())"
	))
}

fn read_spans(text: &CFAttributedString) -> CoreResult<Vec<Span>> {
	let Some(string) = text.string() else {
		return Ok(Vec::new());
	};
	let units: Vec<u16> = string.to_string().encode_utf16().collect();
	let length = text.length();
	let mut spans = Vec::new();
	let mut location = 0;
	while location < length {
		let mut run = CFRange { location, length: 0 };
		// SAFETY: `location` is inside the string and `run` is writable.
		let attributes = unsafe { text.attributes(location, &mut run) };
		if run.length <= 0 {
			break;
		}
		let start = usize::try_from(run.location).unwrap_or(0).min(units.len());
		let end = usize::try_from(run.location + run.length)
			.unwrap_or(0)
			.min(units.len());
		let mut span =
			Span { text: String::from_utf16_lossy(&units[start..end]), style: Style::default() };
		if let Some(attributes) = attributes {
			// SAFETY: AX attributed strings key their attributes by CFString.
			let attributes =
				unsafe { CFRetained::cast_unchecked::<CFDictionary<CFString, CFType>>(attributes) };
			style_span(&mut span.style, &attributes)?;
		}
		spans.push(span);
		location = run.location + run.length;
	}
	Ok(spans)
}

fn style_span(style: &mut Style, attributes: &CFDictionary<CFString, CFType>) -> CoreResult<()> {
	let get = |key: &'static str| attributes.get(&CFString::from_static_str(key));
	if let Some((bold, italic)) = get("AXFont")
		.and_then(|font| font.downcast::<CFDictionary>().ok())
		// SAFETY: An `AXFont` dictionary maps CFString keys to CF values.
		.map(|font| unsafe { CFRetained::cast_unchecked::<CFDictionary<CFString, CFType>>(font) })
		.and_then(|font| font_traits(&font))
	{
		style.bold = bold;
		style.italic = italic;
	}
	style.strike = get("AXStrikethrough").is_some_and(|value| truthy(&value));
	style.link = match get("AXLink").and_then(|link| link.downcast::<AXUIElement>().ok()) {
		Some(link) => link_url(copy_attribute_result(&link, "AXURL"))?,
		None => None,
	};
	style.heading = get("AXHeadingLevel")
		.and_then(|level| level.downcast::<CFNumber>().ok())
		.and_then(|level| level.as_i64())
		.and_then(|level| u8::try_from(level).ok())
		.filter(|level| (1..=6).contains(level))
		.unwrap_or(0);
	Ok(())
}

/// A link's address from its `AXURL` read. A read that fails fails the whole
/// read, so a link never comes back as plain text.
fn link_url(url: Result<Option<CFRetained<CFType>>, AXError>) -> CoreResult<Option<String>> {
	let url = match url {
		Ok(url) => url,
		Err(error) if error == AXError::NoValue || error == AXError::AttributeUnsupported => None,
		Err(error) => {
			return Err(DesktopError::ax_failed(format!(
				"reading a link's address failed ({error:?}); read the text again"
			)));
		},
	};
	Ok(url
		.and_then(|url| match url.downcast::<CFURL>() {
			Ok(url) => Some(url.string().to_string()),
			Err(url) => url.downcast::<CFString>().ok().map(|url| url.to_string()),
		})
		.filter(|url| !url.is_empty()))
}

/// Bold and italic of an `AXFont` dictionary. `WebKit` states them as
/// `AXFontBold` / `AXFontItalic` flags; any other text view names a font whose
/// own traits say it. A system UI font (a `.`-led name such as `.SFNS-Bold`)
/// is never looked up: `CoreText` refuses it by name and logs a note to omp's
/// stderr.
fn font_traits(font: &CFDictionary<CFString, CFType>) -> Option<(bool, bool)> {
	let flag = |key: &'static str| font.get(&CFString::from_static_str(key));
	let (bold, italic) = (flag("AXFontBold"), flag("AXFontItalic"));
	if bold.is_some() || italic.is_some() {
		return Some((bold.is_some_and(|v| truthy(&v)), italic.is_some_and(|v| truthy(&v))));
	}
	let name = font
		.get(&CFString::from_static_str("AXFontName"))?
		.downcast::<CFString>()
		.ok()?
		.to_string();
	if name.starts_with('.') {
		return None;
	}
	let size = font
		.get(&CFString::from_static_str("AXFontSize"))
		.and_then(|size| size.downcast::<CFNumber>().ok())
		.and_then(|size| size.as_f64())
		.unwrap_or(12.0);
	let traits = NSFont::fontWithName_size(&NSString::from_str(&name), size)?
		.fontDescriptor()
		.symbolicTraits();
	Some((
		traits.contains(NSFontDescriptorSymbolicTraits::TraitBold),
		traits.contains(NSFontDescriptorSymbolicTraits::TraitItalic),
	))
}

fn truthy(value: &CFType) -> bool {
	if let Some(flag) = value.downcast_ref::<CFBoolean>() {
		return flag.as_bool();
	}
	value
		.downcast_ref::<CFNumber>()
		.and_then(CFNumber::as_i64)
		.is_some_and(|number| number != 0)
}

/// Renders styled runs as Markdown: `**bold**`, `*italic*`, `~~struck~~`,
/// `[text](url)`, a heading line as `## text`, and list lines as `- item` /
/// `1. item`. Markdown punctuation in the text is escaped. `AppKit` lays out a
/// nested item with the same single leading tab as its parent (its indent
/// lives in the paragraph style, which accessibility does not expose), so
/// every item is top level.
pub(super) fn to_markdown(spans: &[Span]) -> String {
	let lines = split_lines(spans);
	let mut rendered = Vec::with_capacity(lines.len());
	// Whether the last non-empty line was a list item.
	let mut previous: Option<bool> = None;
	for line in &lines {
		let plain: String = line.iter().map(|span| span.text.as_str()).collect();
		if plain.is_empty() {
			previous = None;
			rendered.push(String::new());
			continue;
		}
		let heading = line.first().map_or(0, |span| span.style.heading);
		let item = if heading == 0 {
			list_item(&plain)
		} else {
			None
		};
		// A list and a paragraph next to each other need a blank line, or the
		// paragraph reads as part of the item (or an ordered list as text).
		if previous.is_some_and(|was_item| was_item != item.is_some()) {
			rendered.push(String::new());
		}
		previous = Some(item.is_some());
		let (marker, consumed) = if heading > 0 {
			("#".repeat(usize::from(heading)) + " ", 0)
		} else {
			item.unwrap_or_default()
		};
		rendered.push(render_line(line, marker, &plain[consumed..], consumed, heading > 0));
	}
	rendered.join("\n")
}

/// The runs cut into lines at `\n`, `\r\n`, `\r`, U+2028 and U+2029, each line
/// merging neighbouring runs of one style.
fn split_lines(spans: &[Span]) -> Vec<Vec<Span>> {
	let mut lines: Vec<Vec<Span>> = vec![Vec::new()];
	let mut after_cr = false;
	for span in spans {
		for c in span.text.chars() {
			if c == '\n' && after_cr {
				after_cr = false;
				continue;
			}
			after_cr = c == '\r';
			if matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
				lines.push(Vec::new());
				continue;
			}
			let line = lines.last_mut().expect("one line");
			match line.last_mut() {
				Some(last) if last.style == span.style => last.text.push(c),
				_ => line.push(Span { text: c.to_string(), style: span.style.clone() }),
			}
		}
	}
	lines
}

/// A list line: `AppKit`'s `\t•\t` (any bullet glyph) or `\t3.\t` / `\t3\t`,
/// or `WebKit`'s `• ` at the line's start. Returns its Markdown marker (`- `,
/// `3. `) and the bytes the original marker takes. `WebKit`'s `3. ` is the
/// same text a person types, so it stays text.
fn list_item(line: &str) -> Option<(String, usize)> {
	let tabs = line.bytes().take_while(|byte| *byte == b'\t').count();
	if tabs == 0 {
		let glyph = line.chars().next()?;
		let after = glyph.len_utf8();
		return (is_bullet(&line[..after])
			&& !matches!(glyph, '-' | '*' | '+')
			&& line[after..].starts_with(' '))
		.then(|| ("- ".to_owned(), after + 1));
	}
	let rest = &line[tabs..];
	let marker_end = rest.find('\t')?;
	let glyph = &rest[..marker_end];
	let digits = glyph.trim_end_matches(['.', ')']);
	let marker =
		if !digits.is_empty() && digits.len() <= 9 && digits.bytes().all(|b| b.is_ascii_digit()) {
			format!("{digits}. ")
		} else if is_bullet(glyph) {
			"- ".to_owned()
		} else {
			return None;
		};
	Some((marker, tabs + marker_end + 1))
}

fn is_bullet(glyph: &str) -> bool {
	matches!(
		glyph,
		"•" | "◦"
			| "▪"
			| "▫"
			| "‣"
			| "⁃"
			| "-"
			| "–"
			| "—"
			| "*"
			| "+"
			| "○"
			| "●"
			| "■"
			| "□"
			| "◆"
			| "◇"
			| "✓"
	)
}

/// One line: `prefix`, then the runs after the first `skip` bytes, whose text
/// is `content`. A heading's text is set in a bold font, which the `#` marker
/// already says.
fn render_line(line: &[Span], prefix: String, content: &str, skip: usize, heading: bool) -> String {
	let mut out = prefix;
	// Four columns of leading whitespace start an indented code block, which
	// shows emphasis and links as typed: the first character is written as a
	// character reference instead, which is not indentation.
	let (content, mut skip) = match code_indent(content) {
		Some(reference) => {
			out.push_str(reference);
			(&content[1..], skip + 1)
		},
		None => (content, skip),
	};
	let escapes = [block_escape(content), heading.then(|| heading_close(content)).flatten()];
	let mut offset = 0;
	for span in line {
		if skip >= span.text.len() {
			skip -= span.text.len();
			continue;
		}
		let text = &span.text[skip..];
		skip = 0;
		let style = Style { bold: span.style.bold && !heading, ..span.style.clone() };
		push_span(&mut out, &style, text, offset, escapes);
		offset += text.len();
	}
	out
}

/// The character reference for `content`'s first character when its leading
/// whitespace reaches four columns before any text.
fn code_indent(content: &str) -> Option<&'static str> {
	let mut column = 0;
	for c in content.chars() {
		match c {
			' ' => column += 1,
			'\t' => column += 4 - column % 4,
			_ => break,
		}
	}
	let text = content.trim_start_matches([' ', '\t']);
	if column < 4 || text.is_empty() {
		return None;
	}
	Some(if content.starts_with('\t') {
		"&#9;"
	} else {
		"&#32;"
	})
}

/// Where a line's text needs a backslash so it is not read as a heading, quote,
/// list, setext underline or rule: before its first non-space character
/// (`#`, `>`, `+`, `-`, `=`), or before the `.`/`)` after a leading number.
fn block_escape(content: &str) -> Option<usize> {
	let start = content.len() - content.trim_start_matches(' ').len();
	let body = &content[start..];
	if body.starts_with(['#', '>', '+', '-', '=']) {
		return Some(start);
	}
	let digits = body.bytes().take_while(u8::is_ascii_digit).count();
	(digits > 0 && matches!(body.as_bytes().get(digits), Some(b'.' | b')')))
		.then_some(start + digits)
}

/// Where a heading's text needs a backslash so its trailing `#`s are not read
/// as the heading's closing sequence: before the first of them, when a space
/// or the line's start comes before them.
fn heading_close(content: &str) -> Option<usize> {
	let text = content.trim_end_matches([' ', '\t']);
	let start = text.trim_end_matches('#').len();
	(start < text.len() && (start == 0 || text[..start].ends_with([' ', '\t']))).then_some(start)
}

/// `text` in `style`, starting `offset` bytes into its line's content.
fn push_span(
	out: &mut String,
	style: &Style,
	text: &str,
	offset: usize,
	escapes: [Option<usize>; 2],
) {
	let styled = style.bold || style.italic || style.strike || style.link.is_some();
	let trimmed = text.trim_matches(char::is_whitespace);
	if !styled || trimmed.is_empty() {
		escape_into(out, text, offset, escapes);
		return;
	}
	let lead = text.len() - text.trim_start_matches(char::is_whitespace).len();
	let trail = lead + trimmed.len();
	escape_into(out, &text[..lead], offset, escapes);
	let marks = match (style.bold, style.italic) {
		(true, true) => "***",
		(true, false) => "**",
		(false, true) => "*",
		(false, false) => "",
	};
	if style.strike {
		out.push_str("~~");
	}
	out.push_str(marks);
	if style.link.is_some() {
		// A `!` right before the `[` would make the link an image.
		if out.ends_with('!') {
			let before = &out[..out.len() - 1];
			if (before.len() - before.trim_end_matches('\\').len()).is_multiple_of(2) {
				out.insert(out.len() - 1, '\\');
			}
		}
		out.push('[');
	}
	escape_into(out, trimmed, offset + lead, escapes);
	if let Some(url) = &style.link {
		out.push_str("](");
		push_url(out, url);
		out.push(')');
	}
	out.push_str(marks);
	if style.strike {
		out.push_str("~~");
	}
	escape_into(out, &text[trail..], offset + trail, escapes);
}

/// A link destination that parses back to `url`: Markdown's escapable
/// characters escaped, whitespace and control characters percent-encoded.
fn push_url(out: &mut String, url: &str) {
	for c in url.chars() {
		if matches!(c, '\\' | '(' | ')' | '<' | '>' | '&') {
			out.push('\\');
			out.push(c);
		} else if c.is_whitespace() || c.is_control() {
			let mut bytes = [0; 4];
			for byte in c.encode_utf8(&mut bytes).bytes() {
				let _ = write!(out, "%{byte:02X}");
			}
		} else {
			out.push(c);
		}
	}
}

/// Escapes inline Markdown punctuation, and the characters at `escapes`
/// (offsets into the line's content), so the text reads back as itself.
fn escape_into(out: &mut String, text: &str, offset: usize, escapes: [Option<usize>; 2]) {
	for (index, c) in text.char_indices() {
		if escapes.contains(&Some(offset + index))
			|| matches!(c, '\\' | '*' | '_' | '`' | '[' | ']' | '~' | '<' | '&')
		{
			out.push('\\');
		}
		out.push(c);
	}
}

#[cfg(test)]
mod tests {
	use objc2_application_services::AXError;
	use objc2_core_foundation::{
		CFBoolean, CFDictionary, CFIndex, CFNumber, CFRetained, CFString, CFType, Type,
	};

	use super::{
		Span, Style, ensure_readable, font_traits, link_url, read_whole, style_span, text_length,
		to_markdown,
	};
	use crate::desktop::error::{DesktopError, ErrorCode};

	fn plain(text: &str) -> Span {
		Span { text: text.into(), style: Style::default() }
	}

	fn bold(text: &str) -> Span {
		Span { text: text.into(), style: Style { bold: true, ..Style::default() } }
	}

	fn italic(text: &str) -> Span {
		Span { text: text.into(), style: Style { italic: true, ..Style::default() } }
	}

	fn link(text: &str, url: &str) -> Span {
		Span { text: text.into(), style: Style { link: Some(url.into()), ..Style::default() } }
	}

	#[test]
	fn styles_links_and_lists_become_markdown() {
		let spans = [
			bold("Plan\n"),
			plain("Make it "),
			bold("bold"),
			plain(", "),
			italic("italic"),
			plain(" and "),
			link("a link", "https://example.com/doc"),
			plain(".\n\t•\tfirst item\n\t•\tsecond "),
			bold("item"),
			plain("\n\t1\tstep one\n\t2.\tstep two\n"),
		];
		assert_eq!(
			to_markdown(&spans),
			"**Plan**\nMake it **bold**, *italic* and [a link](https://example.com/doc).\n\n- first \
			 item\n- second **item**\n1. step one\n2. step two\n"
		);
	}

	#[test]
	fn runs_split_by_other_attributes_merge_and_whitespace_stays_outside_marks() {
		assert_eq!(to_markdown(&[bold("very "), bold("bold "), plain("text")]), "**very bold** text");
		let struck = Span {
			text:  " gone ".into(),
			style: Style { strike: true, italic: true, ..Style::default() },
		};
		assert_eq!(to_markdown(&[struck]), " ~~*gone*~~ ");
		assert_eq!(to_markdown(&[bold("\u{a0}a\u{2003}")]), "\u{a0}**a**\u{2003}");
		assert_eq!(to_markdown(&[bold("   ")]), "   ");
	}

	#[test]
	fn every_line_separator_ends_a_line_and_emphasis_closes_before_it() {
		assert_eq!(to_markdown(&[bold("a\r\nb")]), "**a**\n**b**");
		assert_eq!(to_markdown(&[bold("a\rb\u{2028}c\u{2029}d")]), "**a**\n**b**\n**c**\n**d**");
		// A CRLF split across two runs is one break.
		assert_eq!(to_markdown(&[plain("a\r"), plain("\nb")]), "a\nb");
		assert_eq!(to_markdown(&[plain("x\u{2028}\t•\titem")]), "x\n\n- item");
	}

	#[test]
	fn plain_text_that_looks_like_markdown_is_escaped() {
		for (text, markdown) in [
			("# not a heading", "\\# not a heading"),
			("  # indented", "  \\# indented"),
			("2. not a list", "2\\. not a list"),
			("10) nor this", "10\\) nor this"),
			("> not a quote", "\\> not a quote"),
			("a\n===", "a\n\\==="),
			("---", "\\---"),
			("x_y*z [a] `c` ~d~", "x\\_y\\*z \\[a\\] \\`c\\` \\~d\\~"),
			("<b>x</b> <https://e.test>", "\\<b>x\\</b> \\<https://e.test>"),
			("a &copy; b", "a \\&copy; b"),
		] {
			assert_eq!(to_markdown(&[plain(text)]), markdown, "{text:?}");
		}
		// A heading marker split from its text by a style change.
		assert_eq!(to_markdown(&[plain("#"), italic(" not")]), "\\# *not*");
		assert_eq!(to_markdown(&[plain(" "), bold("#"), plain(" x")]), " **\\#** x");
		// Four columns of indentation would make a code block that shows the
		// marks as typed; three would not.
		assert_eq!(to_markdown(&[plain("\tindented\tcell")]), "&#9;indented\tcell");
		assert_eq!(to_markdown(&[bold("    bold")]), "&#32;   **bold**");
		assert_eq!(to_markdown(&[plain("  \t"), italic("x")]), "&#32; \t*x*");
		assert_eq!(to_markdown(&[bold("   bold")]), "   **bold**");
		assert_eq!(to_markdown(&[plain("\t•\t    # item")]), "- &#32;   \\# item");
		assert_eq!(to_markdown(&[plain("    ")]), "    ");
	}

	#[test]
	fn link_destinations_parse_back_to_the_url() {
		assert_eq!(
			to_markdown(&[link("doc", "https://x.test/a b(1)\\_&copy;\n<z>")]),
			"[doc](https://x.test/a%20b\\(1\\)\\\\_\\&copy;%0A\\<z\\>)"
		);
		assert_eq!(to_markdown(&[link("[x]", "https://x.test")]), "[\\[x\\]](https://x.test)");
		// A `!` right before a link would make it an image.
		assert_eq!(
			to_markdown(&[plain("Wow!"), link("site", "https://x.test")]),
			"Wow\\![site](https://x.test)"
		);
		assert_eq!(
			to_markdown(&[plain("a\\!"), link("b", "https://x.test")]),
			"a\\\\\\![b](https://x.test)"
		);
		assert_eq!(
			to_markdown(&[plain("Wow! "), link("site", "https://x.test")]),
			"Wow! [site](https://x.test)"
		);
	}

	#[test]
	fn a_link_whose_address_cannot_be_read_fails_the_read() {
		let url: &CFType = &CFString::from_static_str("https://x.test");
		assert_eq!(link_url(Ok(Some(url.retain()))).unwrap().as_deref(), Some("https://x.test"));
		assert_eq!(link_url(Err(AXError::NoValue)).unwrap(), None);
		assert_eq!(link_url(Ok(None)).unwrap(), None);
		let failed = link_url(Err(AXError::CannotComplete)).unwrap_err();
		assert_eq!(failed.code, ErrorCode::AxFailed);
	}

	#[test]
	fn list_lines_become_items_kept_apart_from_paragraphs() {
		// As `AppKit` lays out a nested list: one leading tab at every level.
		assert_eq!(
			to_markdown(&[plain("\t•\ttop\n\t◦\tinner\n\t•\tsecond\n\t10.\tten\n\t11)\televen")]),
			"- top\n- inner\n- second\n10. ten\n11. eleven"
		);
		// Lists and paragraphs are kept apart by a blank line, so an ordered
		// list after text stays a list and text after a list leaves it.
		assert_eq!(to_markdown(&[plain("body\n\t2\titem\nafter")]), "body\n\n2. item\n\nafter");
		// The text after a marker is escaped like a line's start.
		assert_eq!(to_markdown(&[plain("\t•\t# not a heading")]), "- \\# not a heading");
	}

	#[test]
	fn web_headings_and_bullets_become_markdown() {
		// As `WebKit` reads a page: a bold heading run, then `• ` bullet lines.
		let heading = Span {
			text:  "Plan *1*\n\n".into(),
			style: Style { bold: true, heading: 2, ..Style::default() },
		};
		assert_eq!(
			to_markdown(&[heading, plain("Body\n\n• first\n• "), bold("second"), plain("\n1. one")]),
			"## Plan \\*1\\*\n\nBody\n\n- first\n- **second**\n\n1\\. one"
		);
		// A typed `- ` or `* ` is text, not an item, and a bullet glyph needs
		// its space.
		assert_eq!(to_markdown(&[plain("- dash\n•tight")]), "\\- dash\n•tight");
		// Trailing `#`s after a space would close the heading and vanish.
		let heading =
			|text: &str| Span { text: text.into(), style: Style { heading: 2, ..Style::default() } };
		assert_eq!(to_markdown(&[heading("Plan #")]), "## Plan \\#");
		assert_eq!(to_markdown(&[heading("Plan ## ")]), "## Plan \\## ");
		assert_eq!(to_markdown(&[heading("C#")]), "## C#");
		assert_eq!(to_markdown(&[heading("##")]), "## \\##");
	}

	fn font(entries: &[(&'static str, &CFType)]) -> CFRetained<CFDictionary<CFString, CFType>> {
		let keys: Vec<_> = entries
			.iter()
			.map(|(key, _)| CFString::from_static_str(key))
			.collect();
		let keys: Vec<&CFString> = keys.iter().map(|key| &**key).collect();
		let values: Vec<&CFType> = entries.iter().map(|(_, value)| *value).collect();
		CFDictionary::from_slices(&keys, &values)
	}

	#[test]
	fn fonts_say_bold_and_italic_with_web_flags_or_their_own_traits() {
		// As `WebKit` describes a run's font: a system font name, with flags
		// for bold and italic.
		fn style(entries: &[(&'static str, &CFType)]) -> Style {
			let font = font(entries);
			let font: &CFType = &font;
			let attributes =
				CFDictionary::from_slices(&[&*CFString::from_static_str("AXFont")], &[font]);
			let mut style = Style::default();
			style_span(&mut style, &attributes).unwrap();
			style
		}
		let (bold_name, italic_name, regular_name) = (
			CFString::from_static_str(".SFNS-Bold"),
			CFString::from_static_str(".SFNS-RegularItalic"),
			CFString::from_static_str(".SFNS-Regular"),
		);
		let (bold_name, italic_name, regular_name): (&CFType, &CFType, &CFType) =
			(&bold_name, &italic_name, &regular_name);
		let size = CFNumber::new_i64(14);
		let size: &CFType = &size;
		let on: &CFType = CFBoolean::new(true);
		let one = CFNumber::new_i64(1);
		let one: &CFType = &one;
		let strong = style(&[("AXFontName", bold_name), ("AXFontSize", size), ("AXFontBold", on)]);
		assert!(strong.bold && !strong.italic, "{strong:?}");
		let slanted =
			style(&[("AXFontName", italic_name), ("AXFontSize", size), ("AXFontItalic", one)]);
		assert!(slanted.italic && !slanted.bold, "{slanted:?}");
		let regular = style(&[("AXFontName", regular_name), ("AXFontSize", size)]);
		assert!(!regular.bold && !regular.italic, "{regular:?}");
		let helvetica = CFString::from_static_str("Helvetica-Bold");
		assert_eq!(
			font_traits(&font(&[("AXFontName", &*helvetica), ("AXFontSize", size)])),
			Some((true, false))
		);
	}

	#[test]
	fn system_font_names_are_never_looked_up() {
		// `CoreText` logs a note to stderr for each such lookup. The lookup runs
		// in a child test process, whose stderr no other test shares.
		let child = format!("{}::system_font_lookup", module_path!().split_once("::").unwrap().1);
		let output = std::process::Command::new(std::env::current_exe().unwrap())
			.args(["--exact", &child, "--ignored", "--nocapture", "--test-threads=1"])
			.env("PI_NATIVES_SYSTEM_FONT_CHILD", "1")
			.output()
			.unwrap();
		let (stdout, stderr) =
			(String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
		assert!(output.status.success() && stdout.contains("1 passed"), "{stdout}{stderr}");
		assert!(!stderr.contains("CoreText"), "{stderr}");
	}

	#[test]
	#[ignore = "run by system_font_names_are_never_looked_up in its own process"]
	fn system_font_lookup() {
		if std::env::var_os("PI_NATIVES_SYSTEM_FONT_CHILD").is_none() {
			return;
		}
		let name: &CFType = &CFString::from_static_str(".SFNS-Semibold");
		let size: &CFType = &CFNumber::new_i64(14);
		assert_eq!(font_traits(&font(&[("AXFontName", name), ("AXFontSize", size)])), None);
	}

	#[test]
	fn secure_text_fields_and_fields_of_unknown_subrole_are_never_read() {
		let subrole = |name: &'static str| -> Result<Option<CFRetained<CFType>>, AXError> {
			let name: &CFType = &CFString::from_static_str(name);
			Ok(Some(name.retain()))
		};
		let code = |subrole| ensure_readable(subrole).map_err(|error: DesktopError| error.code);
		assert_eq!(code(subrole("AXSecureTextField")), Err(ErrorCode::AxFailed));
		// A subrole read that fails may have been a secure field's.
		assert_eq!(code(Err(AXError::CannotComplete)), Err(ErrorCode::AxFailed));
		assert_eq!(code(Err(AXError::InvalidUIElement)), Err(ErrorCode::StaleRef));
		assert_eq!(code(subrole("AXSearchField")), Ok(()));
		assert_eq!(code(Ok(None)), Ok(()));
		assert_eq!(code(Err(AXError::NoValue)), Ok(()));
		assert_eq!(code(Err(AXError::AttributeUnsupported)), Ok(()));
	}

	#[test]
	fn text_that_changes_length_while_it_is_read_is_read_again() {
		// `lengths` answers the count reads in turn; each read returns
		// `extra` more characters than it asked for.
		fn read(
			lengths: &[CFIndex],
			extra: CFIndex,
		) -> (Result<Option<CFIndex>, ErrorCode>, Vec<CFIndex>) {
			let mut counts = lengths.iter().copied();
			let mut asked = Vec::new();
			let result = read_whole(
				|| Ok(counts.next()),
				|length| {
					asked.push(length);
					Ok((length, length + extra))
				},
			);
			(result.map_err(|error| error.code), asked)
		}
		assert_eq!(read(&[5, 5], 0), (Ok(Some(5)), vec![5]));
		// `WebKit` adds list markers the count leaves out.
		assert_eq!(read(&[5, 5], 2), (Ok(Some(5)), vec![5]));
		// Text appended between the count and the read.
		assert_eq!(read(&[5, 7, 7, 7], 0), (Ok(Some(7)), vec![5, 7]));
		// A read that came back short.
		assert_eq!(read(&[5, 5, 5, 5, 5, 5], -1), (Err(ErrorCode::AxFailed), vec![5, 5, 5]));
		// Text that keeps growing.
		assert_eq!(read(&[1, 2, 3, 4, 5, 6], 0), (Err(ErrorCode::AxFailed), vec![1, 3, 5]));
		assert_eq!(read(&[], 0), (Ok(None), vec![]));
	}

	#[test]
	fn the_length_comes_from_the_count_else_the_utf16_value_and_a_gone_element_is_stale() {
		let count = CFNumber::new_i64(91);
		let count: &CFType = &count;
		let counted =
			text_length(Some(count.retain()), || unreachable!("the count answers")).unwrap();
		assert_eq!(counted, Some(91));
		let text = CFString::from_str("a😀");
		let text: &CFType = &text;
		assert_eq!(text_length(None, || Ok(Some(text.retain()))).unwrap(), Some(3));
		assert_eq!(text_length(None, || Ok(None)).unwrap(), None);
		let stale = text_length(None, || Err(DesktopError::stale_ref("gone"))).unwrap_err();
		assert_eq!(stale.code, ErrorCode::StaleRef);
	}
}
