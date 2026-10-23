## What

When an agent looked for the window of an app that wasn't open yet, the computer tool only said no window matched, so the error now names the `apps.open` call that opens the app and hands back its window.

On macOS, `computer.window({ app: "Reminders" })` for an app that is not running, or runs with no window (Finder after its last window closed), now says what to call:

```diff
 no window matches {"app":"Reminders"}
 No open window belongs to an app matching "Reminders".
+computer.apps.open("Reminders") opens it by that exact name or ID, or shows a window of it if it runs without one, and returns it with its window.
 Open windows by app (id "title"):
 - iTerm: 12 "tmux"
```

| Where | The added line |
|---|---|
| macOS | the line above |
| Linux, Windows | `computer.apps.open("Reminders") launches it by that exact name or ID.` (`apps.open` there only launches, and returns `window: null`) |
| a `read_only` run | none, since `apps.open` is refused there |
| no window open at all | the same line, before `No windows are open.` |

`computer.window()` with no argument matches every window and said `multiple windows match undefined:`; it now says `computer.window() needs a window id or an { app, title } filter; open windows:` over the same list.

## Why

In a day of agent runs on macOS 26 (GPT-6.1 Sol), 8 runs over Reminders, Finder, Contacts and Notes began with this miss, and one more began with `computer.window()`. After the miss the agent called `apps.open` alone and looked the window up again in a third call; a run that knew `apps.open` returns the window did both in one (`(await computer.apps.open(…)).window`).

I kept `computer.window` a pure lookup rather than having it launch apps: a lookup that starts an app as a side effect would surprise a script that only checks whether a window exists. The hint repeats the filter as given and says "exact", since `{ app }` matches a substring while `apps.open` takes an exact name or ID; a partial filter such as `"remind"` then gets `apps.open`'s own "not found; use apps.list()" error.

Reading order: `describeWindowMiss` and `AppOpenRoute` in `packages/coding-agent/src/tools/computer/window-miss.ts`, then `window` in `ComputerWorkerCore` (`worker.ts`).

## Testing

- `window selector misses` in `test/tools/computer.test.ts` covers each row of the table and the call without a selector. With the `src` change reverted, those 4 tests fail and the 3 listing tests still pass.
- `bun test test/tools/computer.test.ts -t "window selector misses"` (7 pass) and `bun run check:types` in `packages/coding-agent`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
