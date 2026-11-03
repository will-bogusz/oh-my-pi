## What

Typing on iPhone Mirroring waited 120 ms between every key press and release, so a short message took seconds; I halved the gap after checking that the phone still got every key, in Spotlight too.

A 39-character mixed string took 283–297 ms/character at 120 ms and 154 ms with this PR, exact in every trial.

| Gap | Safari, 39 chars | Safari, refilter 3,000 rows/key | Spotlight, 26 chars with `ç` | Doubled letters: Safari / Spotlight |
|---|---|---|---|---|
| 120 ms (`main`) | 4/4 exact, 283–297 ms/char | 3/3, 283–292 | 5/5, 8.2 s/string | 5/5 / 5/5 each query |
| 60 ms (PR) | 3/3, 154 | 3/3, 152–154 | 5/5, 4.5 s/string | 5/5 / 5/5 each query |
| 40 ms | 6/6, 108–113 | 3/3, 108–110 | not run | 4/5 / not run |
| 20 ms | 2/3 (final Shift `!` lost), 65–70 | not run | not run | not run |

`REPORT_KEY_GAP` (`macos/input.rs`) paces every iPhone Mirroring key transition: typed text, `press` chords and held keys, in background and takeover. Nothing else changes.

## Why

The HID-report sampling model is consistent with these numbers, not proven. The prototype lost letters at 60 ms in Spotlight's "Full Keyboard Access" (`ll/cc/ss`); its pacing was the same, but it released Shift per character and lacked per-press focus checks. Omp now passes that string and doubled-letter Safari text at 60 ms.

60 ms is three times the only gap that lost a key on omp's route, 20 ms unloaded; saturating Wi-Fi did not raise the observed failure point. Not measured: takeover `type` and `press`, `holdKeys`, other phones/iOS versions, weak-signal or hotspot links. Load is not weak-link coverage; if keys go missing silently, raise this constant.

## Testing

Live on iPhone 16 Pro, iOS 18.7, macOS 26.1; background `type` with addons differing only in this constant, on a branch carrying other Mirroring fixes. Safari values came from input events; Spotlight from capture OCR. Repro: focus, select-all/delete, type and read back; Home then Spotlight for queries.

- Doubled-letter Safari text: "Full Keyboard Access: Hello Will, see you soon at 11:00, Mississippi!"; Spotlight queries: "Full Keyboard Access" and "Settings". At 40 ms the Safari miss was an empty field, not a dropped letter; focus/clear is a hypothesis, not proven.
- Wi-Fi load, 2026-11-02: four parallel 10 GB downloads, 239–439 Mbit/s. The 39-character string was exact 3/3 at each of 20/40/60/120 ms; 60 ms took 152 ms/char, 120 ms 283–290.
- `cargo test -p pi-natives --lib desktop` on macOS; clippy and rustfmt on macOS and Linux.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
