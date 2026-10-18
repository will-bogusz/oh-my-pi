## What

Codex [flagged this on #15174 after it merged](https://github.com/can1357/oh-my-pi/pull/15174#pullrequestreview-5561246943): the screenshot waits for a DevTools session before anything watches the abort signal, so a connected or relay browser that never answers the attach could hold `tab.screenshot()` well past its 20 s limit, and now that wait ends at the deadline like the rest of the capture.

`whileDrawing` (`tools/browser/screenshot.ts`) opens a CDP session to start a screencast, so Chromium draws a background tab for capture. It awaited `page.createCDPSession()` bare; only the `Page.startScreencast` after it raced the signal. The worker's Puppeteer connection has a 60 s protocol timeout, so a pending `Target.attachToTarget` outlived the op's own timeout and could reach the cell timeout, after which the supervisor recycles the tab.

Now the creation races the signal through `untilAborted`, like every other step of the capture. When the abort wins, a session that attaches later is detached as soon as it arrives, so it does not stay attached to the tab. A creation that fails without an abort still falls back to capturing without the screencast, as before.

## Why

A screenshot is a quick op: its deadline is the one the agent was promised, and a browser that stops answering should cost that deadline, not the whole cell.

No CHANGELOG line: #15174 has not shipped in a release yet.

## Testing

- `browser-screenshot-session-abort.test.ts`: a page whose `createCDPSession()` never settles, then an abort. `whileDrawing` rejects with the abort reason within the same turn, the capture never runs, and once the session attaches it is detached. On `main`'s source the call is still pending after the abort and the test fails.
- `browser-screenshot-background.test.ts` and `browser-screenshot-plus.test.ts` against a real headless Chromium: 7 pass.
- `bun run check:ts` at the root.

---

- [ ] `bun check` passes
- [ ] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
