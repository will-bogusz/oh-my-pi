## What

I made `computer.apps.open` read a leading `~` as the home folder, because every agent I watched open a Finder folder wrote `~/…` first and got an error about `.app` bundles.

`computer.apps.open("~/Desktop/Inbox")` failed with `InvalidTarget: macOS application paths must identify an existing .app bundle`; it now opens that folder. The `app` option (`apps.open(file, { app: "~/Applications/Editor.app" })`) reads `~` the same way.

| `apps.open` argument | `main` | this PR |
|---|---|---|
| `"~/Desktop/Inbox"` | looks for `<session cwd>/~/Desktop/Inbox`, fails as an application path | opens `$HOME/Desktop/Inbox` |
| `"~"` | a bare name, resolved as an app name | opens `$HOME` |
| `"./a"`, `"a/b"`, absolute paths, URLs, app IDs and names | unchanged | unchanged |

## Why

`apps.open` resolves a relative path against the session's folder, and a `~/…` argument counted as relative, so it pointed at a `~` folder inside the session cwd. Native resolution then read the missing non-`.app` path as an application, which is where the misleading message comes from. Every other path a tool takes (`read`, `write`, the browser's upload and screenshot paths) already expands `~`.

In a GPT-6.1 computer-use benchmark on a macOS VM, the agent passed a `~/…` path to `apps.open` 9 times in 156 runs (opening a Finder folder, an image in Preview, a text file), and all 9 failed before it retried with the absolute path. Four of those runs also filed a `report_issue` about it, so each hit cost one or two tool calls.

The expansion is written inline in `sessionPath` instead of importing `expandTilde` from `tools/path-utils.ts`: that module pulls about 1,280 modules into the computer worker and makes it load in about 265 ms instead of 15 ms. It covers `~`, `~/…` and `~` followed by the platform separator; `~user` stays a name, as before.

## Testing

`bun test test/tools/computer.test.ts` (in `packages/coding-agent`): the new case "opens a path under ~ in the user's home, for the target and the app" passes, and with `worker.ts` from `main` it fails with the ids resolved under `test/tools/~/…`. The existing relative-path and exact-ID cases are unchanged.

Not run: a live `apps.open` on a desktop. The change only rewrites the argument before the native call, and the benchmark runs show native opening the expanded absolute path.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
