## What

Dragging across a sentence in TextEdit never needed the mouse, so instead of refusing it or taking over the app I'm typing in, the agent now sets that selection through accessibility.

A background drag across a TextEdit document's text had no background route, so the tool reran it in takeover, which pulled the user out of their app and typed 3 of their 15–16 keys over the agent's new selection (5/5). It now makes the same selection in 0.34–0.44 s, every user key landing in their app, which stays in front (13/13).

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/1e787d78-3951-4f5a-a234-7987e4f47216">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/7bf5c2fe-1ba2-4b0b-986d-4ccb8fd419f3">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/a38d718f-554a-4a51-8959-46479342df88">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/b084aef7-42fe-441d-8757-3eaf7e77e034">
  <img width="780" alt="Decision flow for a background left drag while you type in another app. A takeover drag is still posted as a real drag, and a background drag with a modifier or held key goes to the existing drag gate. A drag whose ends are not both on the text of one native text view in the target window, with a settable selection and a caret accessibility can place at each end, keeps main's drag gate: sliders, scroll bars, value indicators, splitters and steppers drag; links, Chrome page text and Finder files have no background route. A press on selected text or an attachment, or text holding right-to-left script, has no background route: the press would pick the item up, or a caret's side of a character flips with the run's direction. Otherwise main refused, or reran it in takeover, which pulled you out of your app; this PR selects the text through accessibility with no mouse event, and your app keeps every key." src="https://github.com/user-attachments/assets/7bf5c2fe-1ba2-4b0b-986d-4ccb8fd419f3" />
</picture>

<details><summary>The same, as a table</summary>

| Background left drag while the user types in another app | before | this PR |
|---|---|---|
| across text in one native text view (TextEdit) | no background route: `BackgroundUnavailable`, or a takeover rerun under `computer.backgroundFallback` | selected through accessibility, no mouse event; `win.drag` returns `{ start, length, text, focused }` and prints `drag selected "…" through accessibility instead of dragging` |
| pressing on selected text, a link or an attachment in that view | no background route | still none (it would pick the item up) |
| across right-to-left text (Hebrew, Arabic) in that view | no background route | still none (a caret's side of a character flips with the run's direction) |
| Chrome page text, links, draggable page elements, Finder files | no background route | still none |

</details>

Reading order: `macos/input.rs` `drag_selection`, `selecting_drag` → `ax/selection.rs` `select_dragged`, `character_caret`, `dragged_range`, `write_selection` → `desktop/mod.rs` `Request::Drag`, `DesktopSession::drag` → `worker.ts` `Win.drag`.

## Why

Background left drags run only from sliders, scroll bars, splitters and steppers: any other press can pick up an item into a drag-and-drop session that macOS finishes at the user's real pointer. A drag across text needs no press. Each end becomes a caret from `AXRangeForPosition` and `AXBoundsForRange` (before the character on its leading half, after it on the trailing half), and the range is written as `AXSelectedTextRange` through `selectText`'s verified write. No mouse event, no session.

Decisions:
- **Chrome page text keeps the refusal.** Chrome applies `AXSelectedTextMarkerRange` only to editable nodes, `AXTextMarkerForPosition` answers nothing, and character bounds exist only after `AXEnhancedUserInterface` switches all of Chrome into screen-reader mode.
- **Posting the drag when the press lands on plain text** was rejected for the same reason the drag gate exists: which presses start a session is up to each app.
- **`takeover: true` still posts a real drag**, for dragging text to move it.
- **`DesktopSession.drag` resolves to `{ selection, focusReturn }`**: one call can end as a selection or as a takeover.

Maintenance: a text view answering those two queries wrongly (Chrome: `(0, 0)`, empty bounds) fails the bounds check and keeps the refusal.

## Testing

On a macOS 26.5 VM, a scripted cell drags in app B while a simulated user types into app A every 125 ms and wiggles the real pointer over it. Before = the drag gate (f2f8fd0c5d), refusals retried in takeover. The 3 TextEdit and 3 Finder runs on the rebased PR (7f36960779) use `"refuse"`:

| B, drag | n (before / this PR) | before | this PR |
|---|---|---|---|
| TextEdit, across a line of text | 5 / 13 | refused; takeover: A loses focus 5/5, 3 of 15–16 keys typed into B over the selection | `"ck brown fox jumps"` selected 13/13; A keeps focus and every key 13/13; B's text unchanged |
| TextEdit, starting on selected text | 3 / 6 | refused; takeover: A loses focus | the same |
| TextEdit rich text, starting on a link | 3 / 5 | refused | refused: the press lands on an `AXLink` |
| Finder file | 5 / 8 | refused; takeover: A loses focus, nothing dropped into A | refused with nothing sent, the file unmoved 8/8; with this PR A also keeps focus and every key 3/3 |
| Chrome text, link, draggable card | 5 each | refused; takeover: A loses focus, nothing dropped into A | the same |

The AX caret placement selected exactly what a real drag between the same points selected on 6 of 6 point pairs (reversed, across lines, past the line's end).

Agents, `main` → this PR (stubbed desktop, real tool code):

| Task, while the user types in another app | Haiku | GPT-6.1 Sol |
|---|---|---|
| select text in TextEdit (3 tasks, n = 24): took the user's foreground | 8 → 0 | 0 → 0 |
| "drag across" a TextEdit phrase (n = 8): used the accessibility drag | 0 → 7 | 0 → 7 |
| select a Chrome page sentence (n = 32): selected with the user's app kept in front | 6 → 17 | 21 → 32 |
| drag a slider, drag a Finder file (n = 16 each) | no difference | no difference |

Live, in a macOS VM with `main`'s tool:

| Background input | Chrome page sentence | TextEdit line (control) |
|---|---|---|
| click, then shift-click | selected 5/5, user's app stayed in front | 5/5 |
| triple-click | selected 5/5, user's app stayed in front | 5/5 |

<details><summary>How the agent runs were made</summary>

- `omp -p --mode json --thinking low` with `anthropic/claude-haiku-5-5` and `openai-codex/gpt-6.1-sol`, from fresh worktrees of `main` (0b5c27ab247) and of this PR merged onto it. The computer worker's native session is a fake macOS desktop (rendered screenshots, AX tree, clicks, keys, drags, menus) whose drag follows each side: `main` refuses a drag on text, this PR selects. Each prompt starts "I'm typing in Messages right now." Scored from the fake's call log: any takeover input, raise or activation counts as taking the foreground.
- 95% intervals (Newcombe) for this PR − `main`: Haiku TextEdit foreground −33 pp [−53, −13]; Chrome, user's app kept in front: Haiku +34 [+11, +53], Sol +34 [+17, +52]. Slider and Finder: every difference's interval includes 0.
- The web-page sentence in the tool doc is a148a32dd9. Without it, Sol selected the Chrome sentence with the user's app in front 7 of 32 times (`main` 21/32, −44 pp [−61, −20]): after `selectText` failed on page text it read "web pages including their text … no background route" as no way to select, and stopped. Two other wordings stayed at 9/32 and 2/16.
- Haiku's TextEdit gain comes from the native change: with this PR's code and `main`'s doc it is the same (1/24). The doc line moves Sol from `selectText` to the drag when asked to drag; both kept the user in front.
- Live check: a clone of a macOS 26.5.2 bench VM, `main`'s own computer tool with `computer.backgroundFallback: "refuse"`, Calculator in front, Chrome (fresh profile) and TextEdit behind; Chrome's selection read from the page title and `AXSelectedText`.

</details>

At b22d16f4d8 with our other open native PRs: `cargo test -p pi-natives` passes on macOS (926) and Linux (620); TS tests (133) ran at c67722be, no TypeScript changed since. Each new test fails with its change removed: the session posting the drag, the selected-text and right-to-left checks, a front read after the target's probes, the old `Win.drag`, and the notice's width cap.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)






