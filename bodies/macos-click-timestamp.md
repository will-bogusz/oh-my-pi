## What

I wanted background clicks into Chrome and Electron apps to stop killing the page they click.

A background left click from the computer tool killed the page of an Electron app on every click, and of Chrome whenever the click changed the URL in place (`history.pushState`), while the tool reported the click as done. Integer field 58 of a Quartz event is its timestamp, and the left-click route wrote a "click group" id there: the sub-second part of the wall clock. Every left click reached the app dated within the first second after boot, older than the page itself, and the renderer aborted with a trap (exit 5); for a navigating click trycua/cua#7292 traced it to the soft-navigation check in Chromium's `soft_navigation_heuristics.cc`.

The click group is gone. Nothing read field 58 as an id: the intervention taps read fields 40-42, double clicks pair on the click-state field, and every other routed pointer event already overwrote it with `stamp_now`. The left-click route now stamps each event with the current time like the rest. Hover, right and middle clicks, drags and holds send the same bytes as before; the wheel event still carries Quartz's 0, now said in a comment.

## Why

The wrong id has been written since v18.3.3. An Electron app lost its page state on every background left click, and the agent carried on as if the click had worked.

## Testing

Background `win.click` with TextEdit in front, macOS 26.5.2, addon swapped into `@oh-my-pi/pi-coding-agent@18.18.7`. Page died after the click:

| page | main | this branch |
|---|---|---|
| Chrome, click calls `pushState` | 30/30 | 0/30 |
| Electron 45.3.0, click calls `pushState` | 30/30 (renderer exit 5) | 0/30 |
| Safari, click calls `pushState` | 0/30 | 0/30 |
| Chrome, click changes nothing | 0/10 | 0/10 |
| Electron, click changes nothing | 10/10 | 0/10 |

In every cell the click landed and TextEdit stayed in front. On main the page read `event.timeStamp === 0` in all three browsers; here it reads the real time. Double clicks still pair on this branch: Chrome saw `detail` 1 then 2 (5/5), an AppKit view `clickCount` 1 then 2 (5/5). `background_left_clicks_carry_the_time_they_are_posted` fails on main (stamps under one second of uptime) and passes here.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
