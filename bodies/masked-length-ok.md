## What

I made `setValue` report a password write as done, with a note, when the field reads back as a mask exactly as long as the text, instead of failing although the text landed.

| KeePassXC unlock field, `setValue`, 5 tries | before | this branch |
|---|---|---|
| result | `AxFailed: wrote 14 characters, but the field now reads as a mask of 14 characters…` | returns; run output: `setValue on e1: the field reads back as a mask of 14 characters, as long as the text written, so the write is reported as done but its value was not confirmed` |
| value landed (revealed with Control+H) | 5/5 | 5/5 |

A write fails only on evidence that the value is wrong. A mask of the right length is no such evidence, only a value that cannot be read, so the write is done and not confirmed. A mask of another length is evidence and still fails; an unreadable value is handled as before.

The note travels as `setValue`'s result: `AxBackend::set_value` returns an optional note, `axSetValue` resolves to it, and the computer tool prints it in the run output. Linux's two masked-success paths (a GTK, Qt or GTK4 password field whose mask has the written length) now return the same note where they were silent. Typing into such a field by accessibility insertion (`el.type`, `win.type`) follows the same verdict without a note, since `type` has no result to carry one and text sent as keys is never read back at all.

## Why

KeePassXC's Qt password field reports a plain text role and reads back one bullet per character. Every correct `setValue` into it failed, so an agent filling a password manager's unlock field would retry or give up on a write that worked. The note keeps the agent from treating the value as verified.

## Testing

- macOS 26.5.2 VM, KeePassXC 2.8.0 started with `--allow-screencapture`, throwaway database, 5 tries: `setValue` returned with the note 5/5, the value landed 5/5, and the written value appeared nowhere in the tool result (searched in memory).
- `cargo test -p pi-natives --lib -- readback mask a_text_write_the_app_ignores_fails` passes on Linux (the shared `text_readback` tests and Linux's write table). On the previous revision, with the same-length arm absent, `a_mask_as_long_as_the_text_is_done_but_not_confirmed_whatever_its_role` fails, and with Linux's notes absent `a_text_write_the_app_ignores_fails` fails. `a_mask_of_another_length_fails_and_never_quotes_the_text` covers a field that truncates or pads.
- `bun test test/tools/computer.test.ts`: 146 pass, including the new note test.
- `rust-check` on macOS, Linux and Windows.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
