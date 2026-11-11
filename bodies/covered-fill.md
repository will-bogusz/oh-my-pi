## What

When a modal popped up mid-task, the browser tool's `fill` typed into the modal's button, clicked it, and said the fill worked, so I made `fill`, `type` and `press` refuse a field the modal covers the way `click` already does.

With a `<dialog>` open over the page, `fill`, `type` and `press` on a field behind it sent their keys to the dialog's button and returned success in 60 of 60 calls on `main`; with this PR all 60 fail with click's error and send nothing.

| Call, Chromium, dialog open | `main` | this PR |
|---|---|---|
| `tab.fill` / `type` / `press(key, {selector})`, element-handle forms | keys reach the dialog's focused button (a space or Enter clicks it); success, 60/60 | `tab.fill("label/Full name") blocked: covered by <dialog>`, nothing sent, 60/60 |
| `tab.drag` from a covered element | mouse lands on the dialog; success, 10/10 | `tab.drag() from "…" blocked: covered by <dialog>`, 10/10 |
| `tab.press` on a disabled field | key goes to whatever had focus (it clicked another button); success, 10/10 | `tab.press("Enter", { selector: … }) blocked: the element is disabled`, 10/10 |
| no modal: a field under a banner, a board under a HUD, a field whose focus handler opens a picker over it | keys go where focus went | unchanged |
| `click`, `dblclick`, `check` | already refused | unchanged |

The guard preserves ordinary focus behavior under banners, HUDs and picker overlays; only a modal dialog's cover or a disabled key target is refused. Tab, handle and frame calls use the same decision, and Tern's page kit applies it too. `drag` refuses a covered on-screen endpoint.

Not changed: `select`, `uploadFile` and radio `uncheck` set the named element's value directly; `focus` sends no input; `hover` is untouched; a field hidden by `inert` or `display:none` is out of scope. cmux sets values on the element itself and its `click` has no hit test either.

## Why

A chain `fill(name) → check(terms) → click(Continue)` with a session-expiry dialog open had "Stay signed in" clicked by the space in the name, the fill reported success, and only the next step noticed.

Only a modal's cover is refused: under any other layer focus reaches the field, as on `main`. Refusing every cover as `click` does would make those calls errors; that is your call (`modalOnly: false`). On an uncovered field the focus check rides in the evaluate `fill` already makes.

**Open question: duplicate names.** In the scripted run that found this, 9 of 9 chains whose target gained a same-named twin silently took the first match; a copy inserted *above* the field took the fill 10 of 10 here. Options: (a) keep first-match, as Puppeteer locators do; (b) refuse an input action (`fill`, `type`, `select`, `check`, `press` with a selector) when more than one visible element matches, listing them. I'd take (b): the input goes to an element the agent never read, and a scoped selector fixes it. This PR changes neither.

## Testing

- `bun test test/tools/browser-interactions.test.ts -t "modal dialog covers"` fails on `main`'s source (ten Chromium refusals come back "sent", 63 keydowns reach the dialog's button, Tern's kit aims at the covered field) and passes here; the banner, HUD, picker and off-screen drag cases match `main`. A fake-daemon Tern test pins `press` aiming before it focuses.
- Cost: 100 uncovered calls per helper, three alternating rounds against `main`: medians moved +0.04 to +0.44 ms per call, against +0.14 ms for `select`, which this PR does not touch.
- Not run: Tern and cmux live; Tern's page kit runs in Chromium in the test.

<details><summary>Per helper behind a modal dialog: real eval tool, headless Chrome for Testing, n=10 each</summary>

| helper | `main`: returned / where input landed | this PR |
|---|---|---|
| `tab.fill`, `tab.type`, `handle.fill`, `handle.type` | success / 12 keydowns on the dialog button per call, and a click from the space | `blocked: covered by <dialog>`, nothing |
| `tab.press`, `handle.press` (Enter) | success / Enter and a click on the dialog button | `blocked: covered by <dialog>`, nothing |
| `tab.drag` | success / mousedown and click on the dialog | `blocked: covered by <dialog>`, nothing |
| `tab.press` on a disabled field | success / Enter clicked the focused button | `blocked: the element is disabled` |
| `tab.click`, `dblclick`, `check`, `uncheck` (checkbox), `handle.click`, `handle.check` | `blocked: covered by <dialog>` | unchanged |
| `tab.select`, `handle.select`, `uploadFile`, radio `uncheck` | success / value set on the named element | unchanged |
| `tab.focus`, `scroll`, `scrollIntoView` | success / nothing sent | unchanged |
| `frame.fill`/`type`/`press` (dialog in the parent page) | success / keys reach the named field in the frame | unchanged |
| `tab.hover` | success / pointer on the dialog | unchanged here |

</details>

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
