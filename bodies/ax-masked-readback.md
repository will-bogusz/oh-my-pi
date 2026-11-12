## What

I stopped `setValue` from repeating a password back in its error when the field shows it as dots.

On macOS, `setValue` into KeePassXC's unlock field (a Qt password field) wrote the value, read back `••••••••••••••`, and threw `AxFailed: wrote "<the password>"; the field now reads "••••••••••••••"` in 5 of 5 tries in a macOS 26.5 VM, so the secret went into the transcript through our own error text. The read-back withheld the text only for fields whose subrole is `AXSecureTextField`, and Qt's field reports a plain `AXTextField`. A read-back that is one repeated mask character now counts as a secure field, so it gets the existing secure-field message, which never quotes the value. Linux's write path already treated a masked read-back that way; its `masked` check moves into the shared read-back so both platforms use one rule.

What is written, and whether the call succeeds or fails, do not change: only the error text does.

## Why

Error text is model-visible and lands in the transcript. An agent filling a login with a value it was handed (from a secret store or a placeholder) should never get the plain value back in a failure message.

Limit: a password field that reports a plain role and reads back empty, or cannot be read at all, still quotes the written text (`text_readback`'s unreadable branch); nothing in the read-back tells such a field from an ordinary one.

## Testing

- `cargo test -p pi-natives --lib`: `a_field_that_reads_back_masked_never_quotes_the_text_whatever_its_role` fails with the new check reverted and passes with it; the existing read-back tests and the Linux `linux::ax` tests pass.
- macOS VM (KeePassXC 2.8, launched with `--allow-screencapture`): on `main`, `setValue` landed (the field revealed with Control+H matched the value) and its error quoted the value 5/5.
- `rust-check` on macOS, Linux and Windows.

---

- [ ] `bun check` passes (no TypeScript changes; it fails only in `test/cursor-todo-persistence.test.ts`, the same as on `main`)
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
