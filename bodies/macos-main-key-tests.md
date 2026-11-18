## What

I updated the two macOS typing tests for Return and Tab without dropping their whole-text checks.

The tests now require Return (36) and Tab (48) on both key transitions, with their original Unicode payloads. Other text still uses unmodified key 0 without reading a keyboard layout, including emoji and oversized combining graphemes; both remote-screen kinds still require layout keys.

## Why

Two tests on main predate [adbb616](https://github.com/can1357/oh-my-pi/commit/adbb616f490f6a454ca5d42042a909f89cc145cd), which deliberately sends line breaks and tabs as real keys so background web content does not interpret key 0 as `a`. Reverting that compatibility change would restore the wrong behavior; this is a test-only correction, with no production or user-facing changes.

## Testing

- Existing main reproductions: both tests fail on the old key-0 expectation.
- macOS arm64: `cargo test -p omp-natives --lib desktop`: 720 passed, 0 failed.
- macOS `scripts/rust-check`: clippy and rustfmt pass for the changed Rust lines.
- Independent review: preserved whole-text reconstruction, UTF-16 chunk limits, local modifier/layout rules, and Screen Sharing/iPhone Mirroring planning; removed the internal-only changelog entry and reused the Tab fixture.

Not run: `bun check` (no TypeScript changes), live application or phone input (no production changes).

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
