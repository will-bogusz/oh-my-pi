## What

I wanted to see where an agent is clicking when I watch its browser tab, so this draws its cursor in its colour with its name, placed by omp itself so iframes and my own mouse can't throw it off.

With the new `browser.cursor` setting on (off by default), a headed Chromium or Tern tab omp drives shows the acting agent's arrow and name badge at each pointer move and press; in a recorded headed run it sat at the click point for 9 of 9 clicks, with 0 cursor pixels in the agent's own `tab.screenshot`.

| | `main` | this PR, `browser.cursor` on |
|---|---|---|
| Watching a headed, relay or Tern tab | nothing shows where the agent acts | arrow in the agent's identity colour plus its name, at each move and press omp sends, a ripple on press |
| Screenshots and PDFs the agent takes (`tab.screenshot`, `diffScreenshot`, `frame.screenshot`, `tab.pdf`, raw `page.screenshot()`) | — | cursor hidden for the capture, shown again after |
| Input into an iframe, your own mouse over the page | — | cursor moves to the iframe point; your mouse never moves it; no cursor is drawn inside any iframe |
| `recordStart({ cursor: true })` | its own event-following overlay | the agent cursor alone, no second overlay |
| Setting off | — | identical to `main`: nothing drawn, no hooks added |

Backends: Chromium (managed, spawned, CDP-connected, relay) and Tern; cmux draws none. Non-goal: touch taps.

Reading order: `agent-cursor.ts` → `tab-worker.ts` `#run` → `screenshot.ts` `whileDrawing` → `tern/tern-tab.ts` `#input` → `tab-supervisor.ts` `runInTab`.

## Why

Watching a headed tab, you can't tell where the agent acts, or which agent. We measured omp's existing in-page pointer (the recording overlay), a variant, and this design (Linux, Xvfb, headed Chrome 157, n=10 per row):

| | V1: `main`'s recording cursor, follows page mouse events | V2: V1 + hide per frame on boundary events | V3 (this PR): top document only, placed by omp after its own input |
|---|---|---|---|
| Visible to an outside recording | 10/10 | 10/10 | 10/10 |
| In the agent's screenshot when hidden around the capture | 0/10 | 0/10 | 0/10 |
| Stale second cursor after input into a same-origin iframe | 9/10 | — | 0/10 |
| Stale second cursor after input into a cross-site iframe | 10/10 | 9/10 | 0/10 |
| Jumps to the human's real pointer | 9/10 | — | 0/10 |

Following page events fails because every frame draws its own copy, and Chrome tells the parent nothing when the pointer enters an out-of-process iframe. V3 listens to nothing in the page: it wraps the tab's `page.mouse.move`/`down`, which every element click, hover, drag and coordinate click goes through, and places the cursor in the top document's isolated world without awaiting it, so input timing is unchanged; `page.screenshot` and `page.pdf` (element captures included) hide it. Hiding around a capture cost nothing measurable (median 52–65 ms per capture either way).

Maintenance: if Puppeteer ever routes element clicks around `page.mouse`, the cursor stops following them and the test fails.

**For the maintainer:** nothing changes by default. The trade when a user turns it on: pages can see the element it adds (`#__omp_agent_cursor__` under `<html>`), so a site that fingerprints automation could notice it.

Related: #12702 (a relay click cursor from page events, closed by its author).

## Testing

- `bun test test/tools/browser-agent-cursor.test.ts test/tools/browser-tern-tab.test.ts` (real headless Chrome; fake Tern daemon): cursor at the click only, top document only after an iframe click, hidden for `tab.screenshot` and `tab.pdf`, redrawn after navigation, one cursor in a `cursor: true` recording, removed from a kept page after a worker swap, nothing when off; Tern's op trace on and off. Each new case fails without the source change; 5/5 and 19/19 pass on macOS and Linux.
- Real path on Linux: an `AgentSession` with only `eval` and a mock model supplying cells, `browser.cursor: true`, `browser.headless: false`, Xvfb, an outside `x11grab` frame after each step:

| Check (9 clicks: 3 element, 2 coordinate, 2 into a cross-site iframe, a link, one on the next page) | Result |
|---|---|
| Cursor at the click point in the outside frame | 9/9 (541 px each) |
| Cursor pixels anywhere else in the outside frame | 0 in all 9 |
| Cursor pixels in the agent's `tab.screenshot` | 0 in all 9 |
| Cursor elements inside the iframe | 0 in all 7 frames checked |
| After link navigation | redrawn at the link, then followed the next click |
| Human `xdotool` moves over the page | cursor stayed at the last click |

- Bench graders: 16 headless web tasks' oracle / no-op / wrong-action runs, cursor drawn and not:

| Tasks | Cursor off | Cursor on |
|---|---|---|
| 6 live-site tasks (MBTA, arXiv form, GOV.UK SMP, EDGAR, FRED, CyberChef), run twice per arm | P/F/F ×2 on all 6 | P/F/F ×2 on all 6 |
| 10 fixture tasks (frame sign-in, SPA wizard, records table, upload then navigate, bulk label, form, cross-turn handoff, staged settings, context menu, pointer-only controls) | P/F/F on all 10 | P/F/F on all 10 |

Not run: Tern live (no Tern host this check could drive without someone's pane; the fake-daemon trace covers it), and the relay, which runs the same worker code as the Chromium runs above.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
