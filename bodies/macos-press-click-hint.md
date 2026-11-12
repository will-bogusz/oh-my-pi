## What

When an agent pressed a list row that has no press action, our refusal told it to "click() it instead", and it kept reading that as a window click at the row's bounds, so now the refusal names the element's own click and says why the bounds won't work.

Replayed at that refusal, Haiku's next step went to pixels (a window click at the bounds, or a screenshot) in 22 of 40 sessions with `main`'s text and in 0 of 40 with this text.

| macOS refusal | `main` | this PR |
|---|---|---|
| `press()` on a row, cell or text without `AXPress` | available actions: AXShowDefaultUI, AXShowAlternateUI, Name:Delete⏎Target:0x0⏎Selector:(null); nothing was sent: if this is the control you meant, **click() it instead**, passing the same menu option if you gave one | available actions: showdefaultui, showalternateui. Nothing was sent. If this is the control you meant, **call click() on this element itself (`await el.click()` on the handle you pressed**, with the same `menu` option if you gave one): it aims at the element and needs no screenshot. **Its bounds() are desktop coordinates, not pixels for a window click** |
| a coordinate click before any screenshot | no capture of '65' yet — **take a screenshot of this target first**; coordinate input is in pixels of that screenshot | no capture of '65' yet. Coordinate input is in pixels of a screenshot of this target, **not the desktop coordinates an element's bounds() gives: to click an element, call its own click() (`await el.click()`), which needs no screenshot**; for a pixel click, take a screenshot of this target first |

The action list now holds only names `perform()` takes, spelled as it takes them. App-defined custom actions (Contacts' `Name:Delete`, Reminders' `Name:Details`, several lines each) are left out by the filter `ax()` lines already use, now shared as `performable_name`.

## Why

Most switches to pixel clicks in a set of Haiku runs on Notes, Reminders and Contacts followed the same three steps: `press()` on a list row fails, the agent calls `win.click()` with numbers from that row's `bounds()` and is told to take a screenshot, then it takes one and clicks pixels for the rest of the run. List rows, cells, text and images in these apps offer no `AXPress`, while the element's own `click()` selects them in the background with no screenshot (table below).

Text, not behaviour: making `press()` click such elements would change what `press()` means for every caller. The no-capture text changes on macOS only: on Wayland, AX bounds can be window-relative and window input is refused, so its refusal stays as it was, and so do X11 and Windows.

## Testing

**Which elements refuse `press()`, and what works instead.** A model-free probe on a fresh macOS VM (`main`, 5 elements per row where the list had them) ran `press()`, `el.click()` (selection read back), every listed action through `perform()`, and `el.click({count: 2})`:

| | `press()` | `el.click()` | selects | `el.click({count: 2})` |
|---|---|---|---|---|
| Contacts, Reminders, Notes, System Settings, Finder, Font Book, Mail: rows, cells, text, images (97) | refused 96, ok 1 | 97 of 97 | 77 of 91 | 96 of 97; opens a contact, a note, a folder |

No element needed pixels. Of the 14 clicks whose selection did not read back, 9 are Mail's, whose window had a sheet open, and 5 are Finder and Font Book rows (not diagnosed). The listed `showdefaultui`/`showalternateui` change nothing visible, and `showmenu` closes again in the background.

<details><summary>Haiku 5.5 medium replay setup</summary>

**Next step after the refusal, Haiku 5.5 medium.** 52 recorded Haiku sessions (Notes to Reminders, Reminders, Contacts tasks) were cut at their `press()` or no-capture refusal and continued with `main`'s text and with this PR's: omp from this branch with the computer tool on, recorded messages put back by an extension, every tool call blocked, the next turn classified by regex.

</details>

| cut at | text | element `click()` | window click at coordinates | screenshot | other |
|---|---|---|---|---|---|
| `press()` refusal (40) | `main` | 16 | 12 | 10 | 2 |
| | this PR | 38 | 0 | 0 | 2 |
| no-capture refusal (12 sessions) | `main`, 12 runs | 0 | 0 | 12 | 0 |
| | this PR, 48 runs | 22 | 0 | 26 | 0 |

The no-capture wording was chosen by that replay from four candidates (1 of 12, then 13, 17 and 22 of 48 to the element click).

Unit tests `an_element_without_a_press_action_is_pointed_at_click` (macOS) and `zoom_rejects_missing_invalid_and_stale_frames_before_capture` failed with the code reverted and passed with it before rebasing. Re-run on current main `53dd4c6a319` on bench-mac: `cargo test -p pi-natives --lib desktop::macos` passed 352 tests; `cargo test -p pi-natives --lib desktop::` passed 598, including the merged read-as refusal coverage. macOS `rust-check` passed clippy and rustfmt. Refusals for a ref that reads as another control retain main's general wording; this click guidance only follows an unsupported action.

Live probes and model replays above are historical and were not repeated after rebasing. Not run: GPT-6.1 Sol.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
