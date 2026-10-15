## What

Filling a date with the browser tool turned 2026-10-12 into 61012-02-02, so I made fill set the value on date, time, colour and range inputs instead of typing into them.

In Chrome, `tab.fill` on these inputs typed the value key by key into a control that doesn't take text, so the page got the wrong value with no error:

| `tab.fill(…)` | main | this PR |
|---|---|---|
| date `2026-10-12` | `61012-02-02` | `2026-10-12` |
| datetime-local `2026-10-12T14:30` | `61012-02-02T14:30` | `2026-10-12T14:30` |
| month `2026-10` | empty | `2026-10` |
| week `2026-W41` | `2641-W20` | `2026-W41` |
| colour `#FF8800` | `#000000` | `#ff8800` |
| range (0–10) `7` | `5` (unchanged) | `7` |
| time `14:30`, filled a second time | empty | `14:30` |

A value the input rejects now fails instead: `tab.fill("#date", "12/10/2026")` throws `<input type=date> does not accept "12/10/2026"; give its value format, e.g. "2026-10-12"`.

`fillViaHandle` (behind `tab.fill`, frame fill and element-handle `fill()`) now sets the value through the input's own setter, fires `input` and `change` when it changes, and refuses a value the browser rejects, leaving the old one in place. Every other element takes the same path and round trips as before.

## Why

These inputs are edited through Chrome's picker or slider, not by typing: the date's segments take digits by their own rules, and colour and range ignore keys. Clicking the input to use the picker is no workaround: it opens a native popup outside the page that the agent's Escape key doesn't close in a visible browser.

Decisions:
- **Refuse rather than ignore a rejected value.** The browser turns an invalid date into empty and an invalid colour into black, so a silent set would repeat today's wrong-value bug. The error names the format the model should send.
- **Range is included.** It is a slider rather than a picker, but it broke the same way (typing left it at its midpoint), and the browser's clamping is checked like any other refusal: `11` on a 0–10 slider is refused, not set to 10, and so is `0x5`, which Chrome rejects by falling back to the midpoint.
- **Events only on a change**, the way a pick in the picker reports, and like the empty fill in #14413.
- Date and time inputs can be cleared with `""`; colour and range have no empty value, so `""` is refused.

Non-goals: Tern and cmux have their own `fill` and are untouched; the CHANGELOG line names Chrome. Clicking a picker input still opens Chrome's popup.

## Testing

- New test `fills colour, date, time and range inputs with their value instead of typing into them` (`test/tools/browser-interactions.test.ts`, headless Chrome) fills every type, refills a time, clears a month, refuses six bad values and checks that the page saw exactly one `input`/`change` per real change. With `interactions.ts` reverted to `main` it fails with the values in the main column above; on this branch it passes.
- `bun test test/tools/browser-interactions.test.ts test/tools/browser-run-output.test.ts test/tools/browser-nav-frames-dialogs.test.ts test/eval/browser-prelude-facade.test.ts`: 57 pass. `bun check` passes.
- Not run: relay and visible Chrome; they use the same `fillViaHandle`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
