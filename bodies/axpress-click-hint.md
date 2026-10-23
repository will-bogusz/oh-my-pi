## What

Pressing a button on a web page in Chrome through the computer tool just failed with a list of AX action names, so the error now says nothing happened and to click the element instead, which works.

On macOS, `el.press()` on a link, button or select in a Chrome page fails, because Chrome lists only `AXShowMenu` and `AXScrollToVisible` for them. The refusal now ends with what to do:

```diff
 AxFailed: AX action 'AXPress' is not supported by this element; available actions:
-AXShowMenu, AXScrollToVisible
+AXShowMenu, AXScrollToVisible; nothing was sent: if this is the control you meant,
+click() it instead, passing the same menu option if you gave one
```

The refusal comes before anything is sent, and `el.click()` (with `menu: [...]` for a select) worked on the same elements in every run that tried it; `docs/computer-use.md` already says to use `el.click()` when a control has no press action. Other unsupported actions keep their message.

## Why

In a day of agent runs on macOS 26 (GPT-6.1 Sol), 7 runs hit this 11 times. After 3 of them the agent spent a call re-reading the window's tree before it clicked, since neither the error nor the tree said what would work; the other 8 clicked next.

**Decision for the maintainer:** `press()` could instead fall back to a click when the element lists no `AXPress`, which would also save the failed call itself (11 calls in those runs). I kept the refusal because `docs/computer-use.md` makes it the contract ("unsupported actions throw `AxFailed` even if the application would silently accept the request"), and a click is a different input route (pointer events at the element's position) that `press()` should not switch to silently. The fallback is a few lines in `perform_choosing` if you prefer it.

Linux and Windows choose an activation action differently and are unchanged.

Reading order: `unsupported_action` in `crates/pi-natives/src/desktop/macos/ax.rs`, called from `perform_choosing`.

## Testing

- `an_element_without_a_press_action_is_pointed_at_click` asserts the `AXPress` refusal keeps the action list and names `click()`, and that another unsupported action does not.
- `cargo test -p pi-natives --lib -- an_element_without_a_press_action readback`: 5 pass. `scripts/rust-check` clippy and rustfmt on macOS and Linux.

Not run: a live press on a Chrome page; the element action lists come from the recorded runs.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
