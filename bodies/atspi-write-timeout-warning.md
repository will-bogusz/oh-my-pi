## What

I kept the empty-field warning when Linux `setValue` clears a masked field and then times out or is cancelled before the replacement can be confirmed.

The error still reports `Timeout` or `Cancelled`, but now also says: "setValue emptied the field before this write, so it may now be empty".

## Why

Related: #18914, [Codex finding](https://github.com/can1357/oh-my-pi/pull/18914#discussion_r4542966035).

The request deadline drops the rewrite future, including its error handler. The confirmed-clear flag now lives outside that future, and the caller attaches the warning after the deadline or cancellation returns. Reads, numeric values and writes that never confirmed a clear keep their existing errors; no timeout budget changes.

Review first: `crates/pi-natives/src/desktop/linux/ax.rs`, `set_value` and `write_text`. A timed-out replacement may still arrive later; the warning deliberately does not claim the field is definitely empty.

## Testing

`cargo test -p pi-natives --lib desktop::linux` exercises a peer-to-peer AT-SPI app that stops answering before the clear, during the clear, or during the rewrite, for both deadline expiry and cancellation. The regression checks that only the confirmed-clear case warns; the existing ignored-write case also rejects a false empty-field warning.

Negative control: `interrupted_masked_text_write_warns_if_the_field_may_be_empty` fails on 4988c32c9a with the test added (88 passed, 1 failed), because the rewrite timeout lacks the warning. With the fix, all 89 Linux tests pass, including cancellation after the clear.

Linux `scripts/rust-check --base 4988c32c9a` passed clippy and rustfmt on the final head. Windows and macOS are not affected: the diff changes only Linux Rust code and the natives changelog.

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (added when a PR number exists)
