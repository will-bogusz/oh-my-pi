## What

I made the computer tool tell the model, the first time it moves the pointer over a window in the background on macOS, that the app gets no hover from that move, so it stops waiting for a hover-only control that will never appear.

The note prints once per desktop session, after the first background `win.move()`: the app gets no hover, a takeover move's hover ends before the call returns, and a control shown only on hover is pressed with a takeover click (under `computer.backgroundFallback: "refuse"` it names AX or the user instead). The tool prompt gets the same line next to the other macOS background-route notes, adding that on a web page a plain click often reaches such a control already. Takeover moves, desktop and display moves (which drive the user's own pointer), and Linux and Windows print nothing.

## Why

A background move used to return as a plain success. On an outside benchmark's hover-toolbar task the model moved the pointer to reveal a control, saw nothing change and had no way to know why; a build carrying an earlier version of this note and one other fix went from 0 of 3 to 3 of 3. Once per session because eval sends each window call as its own run, so a per-call note repeated once per move.

## Testing

Every clause of the note comes from this table: a macOS 26 guest, 10 tries per cell, the user's own window in front with their pointer on it, an AppKit view with a tracking area and a Chrome element with `:hover` and `mouseenter`, the app's own state and a 10 ms pointer trace as truth. The hover columns are move-only trials; the click column is separate trials that move and then click the hover-only button in the same cell. Cells read AppKit, Chrome.

| Window route | Move only: app saw hover during the call | Move only: hover when the call returns | Move then click: the click reached the button | User's pointer when the call returns |
|---|---|---|---|---|
| background `move`, plain `click` | 0/10, 0/10 | 0/10, 0/10 | 0/10, 10/10 | never moved |
| `move({ takeover: true })`, plain `click` | 10/10, 10/10 (about 50 ms) | 0/10, 0/10 | 0/10, 10/10 | warped back |
| `move({ takeover: true })`, `click({ takeover: true })` | as above | as above | 10/10, 10/10 | warped back |

Chrome's 10/10 for a plain click is the page's own hit test on the click showing the control, after a background or a takeover move alike. Through the real eval path in the same guest, three background window moves in one cell printed the note once, a later cell printed nothing, and a takeover move printed nothing.

`bun test test/tools/computer.test.ts -t "background move"` covers one note for several window moves across runs, none for runs with no background window move (a takeover move, desktop and display moves, which drive the user's pointer) or a fallback rerun, the refuse wording, and none on `x11`, `wayland` and `win32`.

No model sample set was run for the prompt line: it only matters in a macOS run that needs a hover-only control, which the outside benchmark's hover tasks re-measure.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
