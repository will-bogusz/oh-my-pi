## What

I made a click on a button inside an iframe fail when the page removes that iframe as the button goes down, because Chrome tabs reported those clicks as delivered although the button never got its click.

For child-frame clicks, delivery is checked while the first press is still down as well as after release. A frame already gone before release produces an unconfirmed-input error that says the press reached the page and asks the caller to inspect before clicking again. A frame that closes on the click still counts as delivered.

| Child frame the page removes | Before | Now |
|---|---|---|
| on `pointerdown` or `mousedown` of the first press | delivered, 0 clicks | unconfirmed, 0 clicks |
| on the click (a consent or sign-in frame closing), single or double click | delivered, 1 click | delivered, 1 click |
| never | delivered | delivered |

## Why

Agents treat a delivered click as done and move on, so a menu or dialog that tears its frame down on the press read as a successful action that never happened. A frame removed after the release is the common, legitimate case (the frame acted and closed), so a failed read after the click still counts as delivered; only a frame already gone while the button is held is refused.

Decisions:
- Puppeteer's `frame.detached` sampled at the press acknowledgement was tried first and never fired: Chrome reports the removed frame after acknowledging the press. Reading the record while the button is down does see it.
- Only child-frame clicks pay the extra read; main-frame clicks are unchanged.
- **Beyond the delivery rule:** a frame removed on `mousedown` now fails although the element saw that `mousedown`, which `main` counts as delivered when its record survives; the lost record cannot tell `mousedown` from `pointerdown`, and the message says the press reached the page.

Non-goal: a frame the page tears down asynchronously after the press (a timer, a `postMessage` to the parent) can still slip between the read and the release.

Unchanged from `main`: a child frame the page removes before the press makes `main`'s detached-element check (`watch.evaluate`) reject, so that click fails with Puppeteer's own detached-frame error, as it does on `main` today; this change adds no handling for it.

## Testing

- Against `main` with headless Chrome: an iframe button that removes its frame on `pointerdown` was reported clicked while its click handler never ran, 5 of 5.
- `browser-interactions.test.ts` "fails a click whose frame the page removes while the first press is down, and keeps one it removes on a click" covers the rows above, double clicks included. With the fix reverted it fails (`clicked` where `unconfirmed` is expected); with it, it passes twice, beside the existing delivery, shadow-root and click-count tests. `bun test test/tools/browser-interactions.test.ts -t "frame the page removes"`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
