## What

Anything I ran over `ssh` through the bash tool came back with long lines cut at 120 characters and the blank lines gone, which broke JSON from remote commands, so the ssh filter now strips only ssh's own notices and leaves the remote output as printed.

The bash tool's result for `ssh host 'printf "%0300d\n\n" 1 2 3 4'` (four 300-digit numbers ending in 1 to 4, each followed by a blank line), captured live from omp. On `main` the four lines become the same 120 zeros, so the digits that tell them apart are gone:

```text
main                                    this PR
000000…000000…[+180]   (120 zeros)      000000…0000001   (300 chars)
000000…000000…[+180]                   
000000…000000…[+180]                   000000…0000002
000000…000000…[+180]                   
[raw output: artifact://1]              000000…0000003
                                        
                                        000000…0000004
```

The filter still drops ssh's own notices (`Warning: Permanently added`, `Connection to … closed.`, `debug1:` and the like) and still keeps only the first 100 and last 80 of more than 200 lines.

## Why

`defs/ssh.toml` says the filter should "leave the remote command output untouched", and its TOML tests keep blank lines. What runs for `ssh` is the Rust `compact_ssh_output` in `filters/system.rs`, which also called `truncate_line(line, 120)` on every remote line and treated empty lines as noise. A width cap suits output the filter understands (`ps`, `git log`); `ssh` prints whatever the remote command printed, so a cut line is a corrupted result (JSON stops parsing, a path or hash loses its tail) and dropped blank lines merge records.

Output made only of notices and blank lines still returns the original capture, as an empty result did before (`out.trim().is_empty()`).

Non-goals: remote `\r\n` still comes back as `\n` (`lines()`); unminimized output still meets the bash tool's 768-column cap (`tools.outputMaxColumns`) like every command; a remote line starting with a notice prefix such as `debug1:` is still dropped, since stdout and stderr arrive merged.

## Testing

- Two tests in `minimizer/engine.rs` drive `apply` with an `ssh` command past the 1,000-character threshold: `ssh_keeps_long_remote_lines_whole` (four 300-character JSON lines between ssh notices come out exactly) and `ssh_keeps_blank_remote_lines`. With the `system.rs` change reverted both fail: the lines end at 120 characters with `…[+N]`, and the blank lines are gone.
- `cargo test -p pi-shell`: all pass (929 unit tests, integration tests and doctests); `cargo clippy -p pi-shell --no-deps -- -D warnings` and `cargo fmt --check` clean.
- Live, the block above: `omp -p --mode json` with Haiku 5.5 on Linux, the same prompt run once with an `origin/main` natives addon and once with this branch's, against a real ssh host.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
