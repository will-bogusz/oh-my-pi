## What

I fixed Windows keys so they use the receiving app's layout, not omp's.

Characters and shortcut scan codes now use the receiving window thread's layout for background and takeover input. The background modifier refusal uses that same mapping: keys needing Shift or AltGr are refused before posting so the default `backgroundFallback` reruns them in takeover; keys needing no modifier still post plainly.

Desktop/display input uses the foreground window's layout and supplies modifiers required by character keys, such as Shift for `?` on en-US. Characters absent from that layout are still refused.

## Why

Windows can keep different keyboard layouts per app. Resolving keys on omp's worker thread can therefore report success while typing another character, such as swapping y/z between en-US and de-DE, or miss the Shift required for `1` on French AZERTY when deciding whether background posting is safe.

The layout is passed explicitly to character and scan-code mapping rather than changing omp's thread layout. Console windows that report no layout retain omp's worker-thread mapping. Related precedent: [Cua PR 6201](https://github.com/trycua/cua/pull/6201). Unicode text delivery is not changed.

## Testing

The pure regression checks recipient versus foreground layout selection without touching a desktop; it does not execute Win32 character translation.

## Verification

- Linux: `cargo test -p pi-natives --lib keyboard_mapping_uses_the_receiving_windows_layout`: 1 failed with target selection disabled, 1 failed without the missing-layout fallback, and 1 passed with both enabled.
- Linux `rust-check` and Windows `rust-check --windows` passed clippy and rustfmt; both platform records are saved.
- Live check on a Windows 11 desktop: pending.

---

- [ ] `bun check` passes
- [ ] Tested locally
- [x] CHANGELOG updated (PR attribution added when opened)
