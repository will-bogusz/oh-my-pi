## What

I kept seeing agents' first `computer.windows()` call fail because nothing told them it returns plain records rather than window handles, so this says so where they read it.

With the `computer` tool prompt on `main`, Haiku 5.5 got its first `computer.windows()` call wrong in 8 of 8 runs; with this PR, in 0 of 8, each answering in one call.

`computer.windows()` returns plain records `{ id, app, title, pid?, x, y, width, height, focused }` (dicts in Python), while `computer.window()` returns a `ComputerWindow` handle with `bounds` and methods. The prompt documented only the handle, so agents wrote `w.bounds` / `w["bounds"]` (undefined, `None`, `KeyError`) or `w.id` in Python (`AttributeError: 'dict' object has no attribute 'id'`), then spent a second call printing the keys.

The `computer` tool prompt now states the record shape in one bullet, with Python dict access (`w["x"]`, `w.get("pid")`) and the way to get a handle (`await computer.window(w["id"])`). `docs/tools/computer.md` and `docs/computer-use.md` say the same; the latter said windows carry "logical bounds".

Non-goal: making `windows()` return handles. That changes the API and its cost (one handle per listed window); this PR only describes what it returns.

## Why

On one macOS host, 9 sessions between 09-20 and 10-18 (18.12.1 included) hit this: a Python `AttributeError` on `w.id`, a JavaScript `bounds: undefined`, and an agent printing a record's keys to find its shape. Every backend builds the same `DesktopWindow` struct (`crates/pi-natives/src/desktop/types.rs`), and neither prelude wraps the list, so one sentence covers macOS, Linux and Windows.

Maintenance: the clause names `DesktopWindow`'s fields. A field added there and missing from the clause would show up as agents not using it, not as a failure.

## Testing

- **Live, Haiku 5.5 (`anthropic/claude-haiku-5-5`), print mode**, macOS 26, `computer.enabled: true`, `tools.approvalMode: write` (reads only; no input sent), prompt: "Using the eval tool in Python, call computer.windows() and print each window's id and its top-left position. Read-only: no input." A run fails when its first eval call reads `bounds` or shows an error or `None` positions.

  | Prompt | Failed first call | Eval calls per run |
  |---|---|---|
  | `main` | 8 of 8 (all read `bounds`) | 2-3 (fail, print keys or retry, answer) |
  | this PR | 0 of 8 | 1 |

  Haiku tests instruction following on the cheapest model; larger models made the same mistake in the sessions above.
- **Fields against the real output:** `new DesktopSession().listWindows()` on this Mac returned 27 windows, each with exactly `id, title, app, x, y, width, height, focused, pid` (`pid` is `Option<u32>` in Rust and may be absent on X11 without `_NET_WM_PID`).
- `Not run:` Linux and Windows live listings (no host here); the field set comes from the shared napi struct.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
