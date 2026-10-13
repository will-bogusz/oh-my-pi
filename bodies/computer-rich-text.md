## What

Reading a TextEdit document or a Safari editor through the computer tool gave back plain text, so the agent couldn't tell bold from plain or see where a link pointed, and I wanted it to read that as Markdown.

On macOS, `el.value({ format: "markdown" })` returns a text element's whole text as Markdown. `value()` and `value({ format: "text" })` are unchanged.

| Same element, read in the background | `value()` (`main`) | `value({ format: "markdown" })` |
|---|---|---|
| TextEdit RTF: bold, italic, a link | `Make it bold, italic and a link.` | `Make it **bold**, *italic* and [a link](https://example.com/doc).` |
| TextEdit lists | `\t•\tfirst item` / `\t1\tstep one` | `- first item` / `1. step one` |
| Safari `contenteditable`: `<h2>`, `<b>`, `<i>`, `<ul>` | `Plan` / `Make it bold, italic` / `first item` | `## Plan` / `Make it **bold**, *italic*` / `- first item` |
| Native secure text field | 20 masked characters | refused: `AxFailed`, the field is never read |
| Chrome or Electron field, a button | — | `AxFailed` naming `ax()`, where such a page shows links and lists as elements |

> **macOS context.** A text view publishes its text twice: `AXValue`, plain, and `AXAttributedStringForRange`, in runs carrying font, strikethrough and link attributes. The new read renders the runs. Chrome gives no value for page fields.

Reading order: `macos/ax/rich_text.rs` (`markdown` → `read_spans` → `to_markdown`), then `worker.ts` `value`.

## Why

**Builds on #15574**: its first 12 commits are #15574's; merge #15574 first, or merge this alone to land both. Both change `value()`; a Markdown read re-finds a rebuilt element like a plain one.

- **Decisions.** Bold and italic come from the font's own traits (`NSFont`), or on a web page from the bold and italic flags Safari puts next to the font, not from guessing at names like `-Bold`. System font names (`.SFNS-Bold`) are never looked up: `NSFont` refuses them and logs to stderr. Markdown punctuation in the text is escaped. It is an option on `value()`, where the model already reads text. A secure field, or one whose subrole read fails, is refused first: Apple doesn't promise its attributed read is masked. Text that changes length mid-read is read again, up to 3 times.
- **Limits.** A nested list item comes out top level: AppKit lays every level out with the same leading tab and keeps the indent in the paragraph style, which accessibility doesn't expose. A Safari ordered list reads as `1\. step` text, because its `1. ` looks exactly like typed text. An AppKit run in the system font (no flags) reads without bold or italic.
- **Non-goals.** Writing Markdown back, tables, images, colors, Chrome pages, Linux and Windows (they throw `Unsupported`).
- **Overlap.** Drafts #15280 and #15282 add lines next to this PR's in `worker.ts` `value()`, the `Response` enum and `MacAx`'s `AxBackend` impl: adjacent insertions, keep both; with #15280 the Markdown read goes through its `#read` too.
- **If Apple changes it.** A text view that stops publishing runs throws the `AxFailed` above, never wrong Markdown.

## Testing

Live on a macOS 26.5 VM, the user's app in front, the target behind; scripted cells read each text area in both formats. Base `main` 818dd42b73; this PR 1e591cdbab (on #15574), identical at b7aeaa28eb off `main`.

| Element, read with `value({ format: "markdown" })` | `main` | this PR |
|---|---|---|
| TextEdit RTF: bold, italic, link address, both lists as Markdown | 0/5 (plain text) | 5/5 |
| AppKit text view in a test app: bold, italic, struck-out text, link, lists, escaped `#` and `2.` | 0/5 | 5/5 |
| Secure text field in that app | 5/5 returned 20 masked characters | 5/5 refused (`AxFailed`) |
| Safari `contenteditable`: heading, bold, italic, link, bullets | 0/5 | 5/5 |
| Chrome `contenteditable` | 1/1 plain text | 1/1 `AxFailed` naming `ax()` |
| User's app lost focus during a run | 0/16 | 0/16 |

- `cargo test -p pi-natives --lib -- desktop`: each Markdown test fails with its fix reverted.
- `bun test test/tools/computer.test.ts`: 65 pass. `reads an element's text as Markdown only when value() asks` fails with `worker.ts` reverted.
- `bun run check:ts`, `cargo fmt --check`, `cargo clippy -p pi-natives --no-deps -- -D warnings`: clean.
- Not run: Notes, Mail.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
