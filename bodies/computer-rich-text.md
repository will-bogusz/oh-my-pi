## What

Reading a TextEdit document or a Safari editor through the computer tool gave back plain text, so the agent couldn't tell bold from plain or see where a link pointed, and I wanted it to read that as Markdown.

On macOS, `el.value({ format: "markdown" })` returns a text element's whole text as Markdown; `value()` is unchanged.

| Same element, read in the background | `value()` | `value({ format: "markdown" })` |
|---|---|---|
| TextEdit RTF: bold, italic, a link | `Make it bold, italic and a link.` | `Make it **bold**, *italic* and [a link](https://example.com/doc).` |
| TextEdit lists | `\t•\tfirst item` / `\t1\tstep one` | `- first item` / `1. step one` |
| Safari `contenteditable`: `<h2>`, `<b>`, `<i>`, `<ul>` | `Plan` / `Make it bold, italic` / `first item` | `## Plan` / `Make it **bold**, *italic*` / `- first item` |
| Native secure text field | 20 masked characters | `AxFailed` naming the ref and its window (`e5 in window <id> ("<title>" in <app>): …`); the field is never read |
| Chrome `<textarea>`, unstyled `contenteditable` | its plain text | its plain text, escaped |
| Chrome `contenteditable` with headings, bold, links | its plain text | `AxFailed` naming the ref, its window and `ax()`, where the page shows links and lists as elements |
| An element the app rebuilt since `ax()` | `StaleRef` naming its replacement | the same |
| `value(["markdown"])`, `value({ format: null })` | on `main`, plain text | refused before any native call |

> **macOS context.** A text view publishes its text twice: `AXValue`, plain, and `AXAttributedStringForRange`, in runs carrying font, strikethrough and link attributes. The new read renders the runs. Chrome publishes none for a formatted `contenteditable`.

Reading order: `macos/ax/rich_text.rs` (`markdown` → `read_spans` → `to_markdown`), `desktop/mod.rs` `name_refusal`, `worker.ts` `valueFormat`.

## Why

- **Decisions.** Bold and italic come from the font's own traits (`NSFont`), or on a web page from the bold and italic flags Safari puts next to the font, not from guessing at names like `-Bold`. It is an option on `value()`, where the model already reads text. A secure field, or one whose subrole read fails, is refused before its text is read, by the check text input already uses: Apple doesn't promise its attributed read is masked. Text that changes length mid-read is read again, up to 3 times.
- **Bounded.** The read stops on a cancel between runs and fails past 2,000 links (one accessibility call each), so a huge document can't hold the desktop worker.
- **Limits.** A nested list item comes out top level: AppKit keeps the indent in the paragraph style, which accessibility doesn't expose. A Safari ordered list reads as `1\. step` text, because its `1. ` looks exactly like typed text. An AppKit run in the system font reads without bold or italic.
- **Non-goals.** Writing Markdown back, tables, images, colors, Chrome pages, Linux and Windows (they throw `Unsupported`).
- **If Apple changes it.** A text view that stops publishing runs throws the `AxFailed` above, never wrong Markdown.

## Testing

Live on a macOS 26.5 VM, the user's app in front, the target behind; scripted cells read each text area in both formats. These runs are from an earlier build whose Markdown conversion is the head's; the cancel checks, link cap and ref naming came later and were not rerun live.

| Element, read with `value({ format: "markdown" })` | `main` | this PR |
|---|---|---|
| TextEdit RTF: bold, italic, link address, both lists as Markdown | 0/5 (plain text) | 5/5 |
| AppKit text view in a test app: bold, italic, struck-out text, link, lists | 0/5 | 5/5 |
| Secure text field in that app | 5/5 returned 20 masked characters | 5/5 refused (`AxFailed`) |
| Safari `contenteditable`: heading, bold, italic, link, bullets | 0/5 | 5/5 |
| Chrome: 2 `<textarea>`s and an unstyled `contenteditable` | 3/3 plain text | 3/3 plain text |
| Chrome `contenteditable` with a heading, bold, italic, link, lists | 1/1 plain text | 1/1 `AxFailed` pointing to `ax()` |
| User's app lost focus during a run | 0/16 | 0/16 |

- `cargo test -p pi-natives --lib` on macOS at the head: 910 pass, 0 fail. With each fix reverted its test fails: the subrole check moved after the read, the cancel checks, the link cap, the ref naming, the `StaleRef` naming, and the indented-code, `!`-link and heading-hash escapes.
- `bun test test/tools/computer.test.ts`: 116 pass. `reads an element's text as Markdown only when value() asks for it` fails with the `Array.isArray` guard removed.
- `bun check` (TypeScript here, Rust with clippy on macOS), the native build and the computer tool's TypeScript tests against it (133 + 7 pass): clean.
- Not run: Notes, Mail, Linux and Windows.

<!-- BENCH s2f-rt -->

<details><summary>Builds</summary>

- Live table: `main` 818dd42b73 against this change at 1e591cdbab (2026-10-13), 16 runs per arm on macOS 26.5.2. Since then `rich_text.rs` changed only in the subrole check (now shared with text input), the cancel checks, the 2,000-link cap and two read errors that used to return empty or cut text; `to_markdown`, the escapes and the font and list handling are unchanged.
- Unit, lint and native checks: 5bdd3af795 on a macOS host; the head e07f43a775 changes only `docs/tools/computer.md`. Revert checks: three builds of this branch (on c9ce6eba21 and 5bdd3af795) with fixes reverted, each named test failing.

</details>

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
