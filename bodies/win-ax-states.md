## What

I fixed Windows accessibility reads so the agent can see control state and get honest stale-reference errors.

| Surface | Before | Now |
| --- | --- | --- |
| Checkboxes/toggle buttons | No fallback value | `0`/`1`/`2` for off/on/indeterminate |
| Selectable items | No marker | `(selected)` |
| Expandable controls | No state | `(expanded)`/`(collapsed)`; leaves unmarked |
| Destroyed refs | No candidate | Unique hint only when UIA proves destruction |

## Why

Raw-view caches share one children read per walk node. A failed children read keeps the node partial; unavailable metadata also blocks uniqueness. Identity hashes control type, labels, AutomationId, class and values, not RuntimeId.

Unavailable element operations report `StaleRef`; unsupported/null VirtualizedItem reads never prove destruction. Expansion needs a shared optional state because available actions do not identify the current state; macOS/Linux leave it unset.

No added model instructions are needed: results identify selection/expansion states and stale-reference errors. Numeric checkbox values are standard UIA toggle states (`0` off, `1` on, `2` indeterminate), observable before and after an action. No model trials were run.

## Testing

`cargo test -p pi-natives --lib`, separately with filters `desktop::win32::ax_states`, `expanded_controls_render_their_state`, and `a_read_that_missed_part_of_the_window_cannot_make_a_ref_refindable`.

## Verification

Linux: all 8 targeted tests passed. All 7 regressions failed with their fixes reverted, then passed with the fixes applied.

Workspace clippy (all targets, vendored forks excluded) and rustfmt passed on Linux, macOS and Windows (via cargo-xwin).

Live check on a Windows 11 guest (WinForms probe form, background `press()` on each control, `ax()` before and after):

| Control | `main` | this PR |
|---|---|---|
| Checkbox "Check", pressed (app logged `checked: true`) | `- checkbox "Check"`, same line before and after | `: "0"` before, `: "1"` after |
| Tree folder "Parent", pressed (selects it) | `- treeitem "Parent"`, no state | `(collapsed)` before; `(selected) (collapsed) (focused)` after |
| OK of a modal MessageBox, pressed once (closes it), then pressed again through the same handle | first press ok; second `AxFailed` ("UI Automation failed: An event was unable to invoke any of the subscribers") | first press ok; second `StaleRef` (UI Automation reports the element unavailable) |

Raw-view parity and the dual-HRESULT destroyed-candidate path have not been live-tested.

---

- [ ] `bun check` passes
- [ ] Tested locally
- [ ] CHANGELOG attribution added when the PR opens
