## What

When a few of my agents drive the desktop at once in the background, the real pointer never moves, so I added an opt-in cursor that shows each agent's colour and name right where its input lands, and kept it out of every agent's screenshots.

| Capability | Behavior |
|---|---|
| Setting | `computer.cursor`, off by default; each run reads it, so turning it on or off applies from the next run |
| Where it is drawn | Clicks, moves, drags and scrolls at the point the input was sent to, once sent; a mouse hold as it starts; element actions at the element's center; typing and keys at the agent's last point |
| Whose | Each agent in its identity colour with its name on a badge (Main is blue); it glides between points, ripples on a click and fades after 8 s idle |
| What agents see | Display screenshots and window listings from any omp process leave out every omp process's cursor; your own recordings show it |
| Input | Never waits: events go through a bounded queue that drops when full; the helper starts on the first event |
| Platforms | macOS 14 and later; macOS 12/13, Linux and Windows draw nothing |

## Why

Background input leaves the real pointer where the user left it, so with several agents at work nothing shows which one is acting where. Two questions decided the design, checked first with a prototype overlay against released omp 18.18.7 through `AgentSession` -> eval -> `computer` on a macOS 26.5 VM (n=10 per row):

| Question | Result |
|---|---|
| Does a cursor drawn exactly at the click point change the click? | Background route 10/10 landed, takeover route 10/10 landed with no refusal, AX hit-test and `computer.elementAt` named the target window 40/40 |
| Does a display screenshot show cursors? | Today's display filter shows both of two omp processes' cursors 10/10; excluding only the process's own helper still shows the other agent's 10/10; excluding every cursor helper by its executable name shows none 10/10, at the same capture time (~60 ms) |

So the overlay is click-through and never key, with no hit-test exclusion, and display captures and window listings leave out every application named `omp-agent-cursor` (so any local process of that name is left out too). One helper shared by every omp process also captured clean, but needs a socket, ownership and lifecycle code; a helper per process, in its own process group, that exits when omp's pipe to it closes needs none.

The colour and name come from the agent identity the Task rows use. Element actions other than `click()` read the element's bounds after the action, only while the cursor is on; `click()` draws at the point it clicked.

Not verified: multiple displays and Retina scaling, full-screen Spaces, Stage Manager.

## Testing

Live check of this branch in a macOS VM (two omp processes, `computer.cursor` on): not yet run.

- `cargo test -p pi-natives --lib -- cursor display_captures_leave_out element_actions_read_bounds agent_cursor_overlays` (9 pass): global-to-display mapping (displays left of and above the main one, a Retina display beside a 1x one, edges), the helper's line encoding, the dropping queue, the capture request that excludes helpers only for display captures, window listings without overlay panels, the worker drawing at the mapped click point, the last point for typing and an element's center, and no bounds read while the cursor is off. Without the change they do not compile.
- `bun test packages/coding-agent/test/tools/computer.test.ts` (147 pass): each run hands the native session the agent's cursor while `computer.cursor` is on and `null` otherwise; the two new tests fail with the `computer.ts`/`worker.ts` change reverted.
