## What

I made a browser call that gives up actually stop: a timed-out click no longer lands once a busy page answers, a drag or key combo cut off halfway no longer leaves the mouse button or Shift held, and relay waits and navigations the page needs more than 20 s for now get the time the call asked for.

| relay tab, n=5 per row | before | this PR |
|---|---|---|
| `tab.clickAt` times out on a page busy 15-30 s | button clicked after the error, 10/10 | 0/10 |
| `tab.drag` cut off with the button down | next `tab.click`: `'left' is already pressed`, 5/5 | released, next click works, 5/5 |
| `tab.press("Shift+a")` times out with Shift down | `a` typed afterwards, 5/5 | Shift released, no `a`, 5/5 |
| `waitForSelector({timeout:40000})`, element at 25 s | fails at 20.0 s, 5/5 | ok at 25 s, 5/5 |
| `tab.evaluate` of a 25 s promise, `tab.goto` to a 25 s server | `extension rpc 'send' timed out after 20000ms`, 10/10 | ok at 25 s, 10/10 |
| plain `tab.click` / `tab.clickAt` | 42-50 ms / 1-2 ms | 37-55 ms / 1-2 ms |

## Why

`untilAborted` stops waiting for puppeteer's `mouse.click` / `keyboard.press`, not sending: their queued steps go out once the page answers. Clicks, drags and combos (tab, frame and handle `press`, clipboard shortcuts) now go one press at a time, an aborted call sends no further press, and every press that went out is released at once. A cut-off run also releases what `tab.mouseDown` / `tab.keyDown` hold.

The relay gave every command 20 s. Commands that wait on the page (`awaitPromise` evaluations, `Runtime.awaitPromise`, `Page.navigate`) now wait 5 s past omp's own 60 s protocol timeout (`BROWSER_PROTOCOL_TIMEOUT_MS`), so the call's timeout decides, as on a launched Chrome; the rest keep 20 s, and one Chrome never answers fails naming the method and tab.

Decisions:
- Buttons are released at (-1, -1): released in place, the click would complete. Off the page Chrome sends it to the document root, not the pressed element.
- A click sends its pointer move with the press, as puppeteer does: on a background tab Chrome holds a move about 5 s for a frame, and the press flushes it.
- Not done: detaching a tab whose command timed out (it stays usable, next call 3-8 ms, n=5), or when omp dies (the relay already detaches within 500 ms, n=5). A dying relay is #9009.

Reading order: `interactions.ts` (`withButtonDown`, `pressKey`), `tab-worker.ts` (`#releaseHeldInput`, handle `press`), `relay/bridge.ts` (`#send`). If puppeteer stops giving a press the position of a move still in flight, `browser-input-release.test.ts` fails.

## Testing

- Live: omp's browser prelude driving the relay and extension in headless Chrome for Testing on macOS, on a background tab opened outside omp; n=5 per arm per row.
- `browser-input-release`, `browser-interactions`, `browser-relay-bridge` and `browser-run-output`, with the eight other `browser-relay-*` files: 227 pass; `bun check` passes. With `src` reverted, 10 of the 12 new input tests fail (2 guard puppeteer refusals kept) and all 4 relay deadline tests.
- Not run: Windows, Linux, a real user's Chrome profile.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution




