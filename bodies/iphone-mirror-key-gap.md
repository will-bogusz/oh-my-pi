## What

Typing on iPhone Mirroring waited 120 ms between every key press and release, so a short message took seconds; I halved the gap after checking that the phone still got every key, in Spotlight too.

Typing a 39-character mixed-case string on the phone took 283–297 ms per character at 120 ms and 154 ms with this PR, exact in every trial.

| Gap between key transitions | Safari text field (39 chars) | Safari field refiltering 3,000 rows per key | iPhone Spotlight (26 chars, one Option `ç`) |
|---|---|---|---|
| 120 ms (as on `main`) | 4 of 4 exact, 283–297 ms/char | 3 of 3, 283–292 | 5 of 5, 8.2 s/string |
| 60 ms (this PR) | 3 of 3, 154 | 3 of 3, 152–154 | 5 of 5, 4.5 s/string |
| 40 ms | 6 of 6, 108–113 | 3 of 3, 108–110 | not run |
| 20 ms | 2 of 3 (final Shift `!` lost), 65–70 | not run | not run |

`REPORT_KEY_GAP` (`macos/input.rs`) paces every key transition omp sends to iPhone Mirroring: typed text (two per plain character, one more per Shift or Option change), `press` chords and held keys, in background and takeover. Nothing else changes.

## Why

The gap needs a margin over the phone's key-state sampling interval; the doc comment's HID-report model is consistent with these numbers, not proven by them. An earlier prototype dropped letters in Spotlight at 60 ms, but paced keys differently; omp's route at 60 ms typed Spotlight exactly in 5 of 5 runs. 60 ms keeps three times the only gap that lost a key, 20 ms unloaded; saturating Wi-Fi did not raise the observed failure point.

Not measured: takeover typing at 60 ms, `holdKeys`, other phones or iOS versions, weak-signal or hotspot links. Load testing is not weak-link coverage. A lost key fails silently; if keys go missing, raise this one constant.

## Testing

- Live, iPhone 16 Pro (iOS 18.7), iPhone Mirroring on macOS 26.1, background `type` with addons differing only in this constant (built on a branch carrying other iPhone Mirroring fixes): table above. Safari values came from input events; Spotlight values from capture OCR. Repro: focus Safari, select-all/delete, type a mixed string and compare; for Spotlight, Home then Spotlight, clear and type.
- Under Wi-Fi load (2026-11-02): four parallel 10 GB downloads saturated the Mac's Wi-Fi at 239–439 Mbit/s. The same 39-character string was exact 3/3 at each of 20/40/60/120 ms; 60 ms took 152 ms/char, 120 ms took 283–290. No loaded run lost a key.
- `cargo test -p pi-natives --lib desktop` on macOS; clippy and rustfmt on macOS and Linux.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
