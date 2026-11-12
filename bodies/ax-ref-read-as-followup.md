## What

I kept macOS ref checks to the role and label they need, and fixed display-target refusals that omitted their recovery refs.

The AX-element-value fixture goes from two extra child attribute requests to none.

| Case | Before | Now |
|---|---|---|
| Ref check whose value is another AX element | Queries the child's title, then description if needed | Decodes only the batched role and labels |
| Relabelled ref read from `display:*` | Refuses without naming recovery refs | Refuses and names the current control and candidate |

## Why

An accessibility value can itself be another element, such as a radio group's selected button. Rendering that unused value adds requests the role/label check does not need. Full snapshots still render values and identity; only the action-time projection narrows.

Non-window recovery now uses the element's owning window, as desktop refs already do, instead of treating a display target as a window ID. This does not retarget actions or change the front-app guard.

## Testing

- macOS (bench-mac) `cargo test -p pi-natives --lib desktop::` on current main bcd5b0b996e: 599 passed.
- With only the production fixes reverted, both regressions fail: the value fixture counts two child attribute requests instead of zero, and the display-target refusal omits the recovery names. Restoring the fixes passes both; the display case also checks that no action was sent.
- `rust-check` passes on macOS, Linux and Windows.

Review `macos/ax.rs::element_labels` and `read_as_values` for label precedence/completeness, then `Worker::name_match` for non-window recovery.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
