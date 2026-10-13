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

use super::{CoreResult, DesktopError, ax_error, copy_attribute, copy_held_attribute, copy_string};

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
	let subrole = copy_held_attribute(element, "AXSubrole")?
		.and_then(|value| value.downcast::<CFString>().ok())
		.map(|value| value.to_string());
	ensure_readable(subrole.as_deref())?;
	// The font lookups run on the session thread, which has no pool of its own.
	autoreleasepool(|_| Ok(to_markdown(&spans(element)?)))
}

/// A secure text field's text is never read, masked or not.
fn ensure_readable(subrole: Option<&str>) -> CoreResult<()> {
	if subrole == Some("AXSecureTextField") {
		return Err(DesktopError::ax_failed("a secure text field's text is never read"));
	}
	Ok(())
}

fn spans(element: &AXUIElement) -> CoreResult<Vec<Span>> {
	let length = text_length(copy_held_attribute(element, "AXNumberOfCharacters")?, || {
		copy_held_attribute(element, "AXValue")
	})?
	.ok_or_else(|| no_formatted_text(element))?;
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
	Ok(read_spans(&text))
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

fn read_spans(text: &CFAttributedString) -> Vec<Span> {
	let Some(string) = text.string() else {
		return Vec::new();
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
			style_span(&mut span.style, &attributes);
		}
		spans.push(span);
		location = run.location + run.length;
	}
	spans
}

fn style_span(style: &mut Style, attributes: &CFDictionary<CFString, CFType>) {
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
	style.link = get("AXLink")
		.and_then(|link| link.downcast::<AXUIElement>().ok())
		.and_then(|link| copy_attribute(&link, "AXURL"))
		.and_then(|url| match url.downcast::<CFURL>() {
			Ok(url) => Some(url.string().to_string()),
			Err(url) => url.downcast::<CFString>().ok().map(|url| url.to_string()),
		})
		.filter(|url| !url.is_empty());
	style.heading = get("AXHeadingLevel")
		.and_then(|level| level.downcast::<CFNumber>().ok())
		.and_then(|level| level.as_i64())
		.and_then(|level| u8::try_from(level).ok())
		.filter(|level| (1..=6).contains(level))
		.unwrap_or(0);
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
fn render_line(
	line: &[Span],
	prefix: String,
	content: &str,
	mut skip: usize,
	heading: bool,
) -> String {
	let mut out = prefix;
	let block = block_escape(content);
	let mut offset = 0;
	for span in line {
		if skip >= span.text.len() {
			skip -= span.text.len();
			continue;
		}
		let text = &span.text[skip..];
		skip = 0;
		let style = Style { bold: span.style.bold && !heading, ..span.style.clone() };
		push_span(&mut out, &style, text, offset, block);
		offset += text.len();
	}
	out
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

/// `text` in `style`, starting `offset` bytes into its line's content.
fn push_span(out: &mut String, style: &Style, text: &str, offset: usize, block: Option<usize>) {
	let styled = style.bold || style.italic || style.strike || style.link.is_some();
	let trimmed = text.trim_matches(char::is_whitespace);
	if !styled || trimmed.is_empty() {
		escape_into(out, text, offset, block);
		return;
	}
	let lead = text.len() - text.trim_start_matches(char::is_whitespace).len();
	let trail = lead + trimmed.len();
	escape_into(out, &text[..lead], offset, block);
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
		out.push('[');
	}
	escape_into(out, trimmed, offset + lead, block);
	if let Some(url) = &style.link {
		out.push_str("](");
		push_url(out, url);
		out.push(')');
	}
	out.push_str(marks);
	if style.strike {
		out.push_str("~~");
	}
	escape_into(out, &text[trail..], offset + trail, block);
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

/// Escapes inline Markdown punctuation, and the block marker at `block` (an
/// offset into the line's content), so the text reads back as itself.
fn escape_into(out: &mut String, text: &str, offset: usize, block: Option<usize>) {
	for (index, c) in text.char_indices() {
		if block == Some(offset + index)
			|| matches!(c, '\\' | '*' | '_' | '`' | '[' | ']' | '~' | '<' | '&')
		{
			out.push('\\');
		}
		out.push(c);
	}
}

#[cfg(test)]
mod tests {
	use objc2_core_foundation::{
		CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, Type,
	};

	use super::{Span, Style, ensure_readable, font_traits, style_span, text_length, to_markdown};
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
		// A tab-led line without a list marker stays text.
		assert_eq!(to_markdown(&[plain("\tindented\tcell")]), "\tindented\tcell");
	}

	#[test]
	fn link_destinations_parse_back_to_the_url() {
		assert_eq!(
			to_markdown(&[link("doc", "https://x.test/a b(1)\\_&copy;\n<z>")]),
			"[doc](https://x.test/a%20b\\(1\\)\\\\_\\&copy;%0A\\<z\\>)"
		);
		assert_eq!(to_markdown(&[link("[x]", "https://x.test")]), "[\\[x\\]](https://x.test)");
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
	}

	#[test]
	fn fonts_say_bold_and_italic_with_web_flags_or_their_own_traits() {
		fn font(entries: &[(&'static str, &CFType)]) -> CFRetained<CFDictionary<CFString, CFType>> {
			let keys: Vec<_> = entries
				.iter()
				.map(|(key, _)| CFString::from_static_str(key))
				.collect();
			let keys: Vec<&CFString> = keys.iter().map(|key| &**key).collect();
			let values: Vec<&CFType> = entries.iter().map(|(_, value)| *value).collect();
			CFDictionary::from_slices(&keys, &values)
		}
		// As `WebKit` describes a run's font: a system font name, with flags
		// for bold and italic.
		fn style(entries: &[(&'static str, &CFType)]) -> Style {
			let font = font(entries);
			let font: &CFType = &font;
			let attributes =
				CFDictionary::from_slices(&[&*CFString::from_static_str("AXFont")], &[font]);
			let mut style = Style::default();
			style_span(&mut style, &attributes);
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
		// A system font without flags is not looked up: `CoreText` would log a
		// note to stderr for it.
		let semibold = CFString::from_static_str(".SFNS-Semibold");
		let (traits, logged) =
			stderr_of(|| font_traits(&font(&[("AXFontName", &*semibold), ("AXFontSize", size)])));
		assert_eq!(traits, None);
		assert!(!logged.contains("CoreText"), "{logged}");
		let helvetica = CFString::from_static_str("Helvetica-Bold");
		assert_eq!(
			font_traits(&font(&[("AXFontName", &*helvetica), ("AXFontSize", size)])),
			Some((true, false))
		);
	}

	/// `f`'s result and what it wrote to fd 2.
	fn stderr_of<T>(f: impl FnOnce() -> T) -> (T, String) {
		use std::{io::Read as _, os::fd::FromRawFd as _};
		let mut fds = [0; 2];
		// SAFETY: The pipe's fds are this function's; fd 2 is restored before
		// the read end is drained.
		unsafe {
			assert_eq!(libc::pipe(fds.as_mut_ptr()), 0);
			let saved = libc::dup(2);
			libc::dup2(fds[1], 2);
			let value = f();
			libc::dup2(saved, 2);
			libc::close(saved);
			libc::close(fds[1]);
			let mut logged = String::new();
			std::fs::File::from_raw_fd(fds[0])
				.read_to_string(&mut logged)
				.unwrap();
			(value, logged)
		}
	}

	#[test]
	fn secure_text_fields_are_never_read() {
		let refusal = ensure_readable(Some("AXSecureTextField")).unwrap_err();
		assert_eq!(refusal.code, ErrorCode::AxFailed);
		assert!(ensure_readable(Some("AXSearchField")).is_ok());
		assert!(ensure_readable(None).is_ok());
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
