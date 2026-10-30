## What

Typing on iPhone Mirroring waited 120 ms between every key press and release, so a short message took seconds; I halved the gap after checking that the phone still got every key, in Spotlight too.

Typing a 39-character mixed-case string on the phone took 283–297 ms per character at 120 ms and 154 ms with this PR, exact in every trial.

| Gap between key transitions | Safari text field (39 chars) | Safari field that refilters a 3,000-row list on every key | iPhone Spotlight (26 chars, one Option `ç`) |
|---|---|---|---|
| 120 ms (as on `main`) | 4 of 4 exact, 283–297 ms/char | 3 of 3, 283–292 | 5 of 5, 8.2 s per string |
| 60 ms (this PR) | 3 of 3, 154 | 3 of 3, 152–154 | 5 of 5, 4.5 s per string |
| 40 ms | 6 of 6, 108–113 | 3 of 3, 108–110 | not run |
| 20 ms | 2 of 3 (the final Shift `!` lost), 65–70 | not run | not run |

`REPORT_KEY_GAP` (`macos/input.rs`) paces every key transition omp sends to iPhone Mirroring: typed text (two per plain character, one more per Shift or Option change), `press` chords and held keys, in background and takeover. Nothing else changes.

## Why

The gap needs a margin over whatever interval the phone samples key state at; the doc comment's model is HID reports, which these numbers are consistent with but do not prove. 120 ms came from an earlier prototype that dropped letters in Spotlight at 60 ms; that prototype paced keys differently, and omp's route at 60 ms typed Spotlight exactly in 5 of 5 runs. 20 ms already lost a key, so 60 ms keeps three times the gap that failed.

Not measured: takeover typing at 60 ms, `holdKeys`, other phones or iOS versions, and a slower link than home Wi-Fi (a hotspot). A lost key fails silently, so if keys go missing there, the fix is raising this one constant.

## Testing

- Live, iPhone 16 Pro (iOS 18.7) through iPhone Mirroring on macOS 26.1, background `type` with addons that differ only in this constant (built on a branch carrying other iPhone Mirroring fixes): the table above. Safari fields were read back from the page's own input events; Spotlight runs (Home, then Spotlight, select-all and delete, then type) were read back by OCR of a window capture.
- `cargo test -p pi-natives --lib desktop` on macOS; clippy and rustfmt on macOS and Linux.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
