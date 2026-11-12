## What

I stopped `setValue` from repeating the text it was asked to write in its error when the field reads back something else, so a password never comes back in a failure message.

On macOS, `setValue` into KeePassXC's unlock field (a Qt password field) wrote the value, read back `••••••••••••••`, and threw `AxFailed: wrote "<the password>"; the field now reads "••••••••••••••"` in 5 of 5 tries in a macOS 26.5 VM. Only fields with the `AXSecureTextField` subrole were spared, and Qt's field reports a plain `AXTextField`. Any password field that reports a plain role had the same exposure whenever its read-back disagreed, including one that reads back empty or not at all, and nothing in the read-back tells such a field from an ordinary one.

The error now gives how many characters were written and what the field reads, and never the written text, for every field:

| Field reads back | Error |
|---|---|
| other text | `wrote 12 characters, but the field now reads "(555) 789-0123". The app may have reformatted it or not taken it; inspect the target before writing again` |
| mask characters | `wrote 14 characters, but the field now reads as a mask of 14 characters. …` |
| empty | `wrote 7 characters, but the field now reads empty. …` |
| nothing readable | `wrote 7 characters, but the field's value could not be read back; inspect the target before writing again` |

A secure field's read-back is still never quoted. The caller already holds what it wrote, so the next step (read the field, or write again) needs nothing the error dropped. macOS and Linux share this read-back (`text_readback`); Linux's own `masked` check moves into it.

What is written, and whether the call succeeds or fails, do not change: only the error text does.

## Why

Error text is model-visible and lands in the transcript. An agent filling a login with a value it was handed (from a secret store or a placeholder) should never get the plain value back in a failure message, and the tool cannot tell from a plain role which fields hold secrets.

## Testing

- `cargo test -p pi-natives --lib -- readback reads_back linux::ax`: 20 pass. With the previous `text_readback` spliced back in, `a_plain_field_that_reads_back_empty_or_unreadable_never_quotes_the_text`, `rewritten_readback_fails_and_names_what_the_field_reads` and `inserted_readback_counts_the_whole_value_it_expected` fail; with the masked arm removed, `a_field_that_reads_back_masked_never_quotes_the_text_whatever_its_role` fails.
- macOS 26.5.2 VM, KeePassXC 2.8 launched with `--allow-screencapture`, `setValue` into the unlock field, 5 tries each: the value landed every time (revealed with Control+H, it matched). On `main` every error contained the value; on this branch none did (searched in the whole tool result), and the error read `wrote 14 characters, but the field now reads as a mask of 14 characters`.
- `rust-check` on macOS, Linux and Windows.

---

- [ ] `bun check` passes (no TypeScript changes; it fails only in `test/cursor-todo-persistence.test.ts`, the same as on `main`)
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
