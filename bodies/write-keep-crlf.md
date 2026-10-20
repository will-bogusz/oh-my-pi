## What

I made `write` keep a file's CRLF line endings and UTF-8 BOM when it replaces the file, the way `edit` already does, instead of turning every line into LF.

| Replacing an existing file with LF text | `main` | this PR |
|---|---|---|
| CRLF file (`.bat`, `.sln`, a Windows checkout) | written LF: every line changes | written CRLF, result says `Note: kept the replaced file's CRLF line endings.` |
| File starting with a UTF-8 BOM | BOM dropped | BOM kept, named in the same note |
| New file, LF file, binary file, content that already has `\r` or a BOM | written as given | written as given, no note |

## Why

Models emit LF text. `edit` (`crates/pi-edit` `files.rs`) restores the file's BOM and line endings on every edit, but the `write` file pipeline wrote the model's text verbatim, so one `write` over a CRLF file rewrote all of its lines and a `.bat` or `.sln` came back LF. On Windows, where CRLF files are common, that is a whole-file diff from a one-line change. Claude Code fixed the same behaviour in its Write tool in v2.1.77.

Decisions:
- Text vs binary is decided by the existing `isProbablyBinaryHeader` sniff of the first 8 KiB, so a binary file (a PNG header contains `\r\n`) is left alone. CRLF means "the first line break is CRLF", the same rule as `edit`'s `detect_line_ending`; a first line longer than 8 KiB is read on in 64 KiB steps to its end.
- Each convention is applied on its own and only to content that lacks it: content with any carriage return keeps its line endings and content starting with a BOM keeps it, so a deliberate conversion still works.
- New files keep the model's line endings; guessing a directory's convention is a separate change.
- The result names what was kept, so the model knows the bytes on disk differ from the text it sent: in a live run without the note, Haiku told the user no CRLF conversion had been applied to the file it had just written as CRLF. The note is read off the text the editor bridge or LSP formatter persisted, so a convention they removed again is not claimed.

Non-goals: archive members, SQLite rows and `conflict://` writes (handler-owned paths) are unchanged.

## Testing

- `packages/coding-agent/test/write-line-endings.test.ts` (9 cases): CRLF kept, BOM kept, both kept and the returned `[path#TAG]` still edits the file, content with `\r` written as given, new/LF/binary files untouched, emptying a BOM file leaves 0 bytes, a CRLF first line break inside / across / past the 8 KiB window, mixed files follow the first break, and an editor bridge that saves LF gets no "kept" note. On `main` the first three and the long-line case fail.
- Every test file that drives `WriteTool` (33 files, 532 tests) passes; `check:types`, `oxlint` and `oxfmt` clean.
- Live: `omp -p` (Haiku 5.5) told to replace a CRLF `run.bat`; the file on disk is `@echo off\r\necho new\r\n`.
- Not run: Windows itself; the change is byte-level and covered by the tests on Linux.

```
cd packages/coding-agent && bun test test/write-line-endings.test.ts
```

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
