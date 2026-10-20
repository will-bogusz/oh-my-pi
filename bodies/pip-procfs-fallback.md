## What

Follow-up to #16300: Codex pointed out after the merge that cancelling `%pip` breaks on Linux hosts without a usable `/proc`, so I made the process walk fall back to `ps` there instead of raising.

Cancelling `%pip` without procfs: installer killed, its child left running → the whole installer tree killed and reaped, on cancel and on kernel shutdown.

| Linux host | `main` | This PR |
|---|---|---|
| `/proc` mounted | children read from `/proc/<pid>/stat` | unchanged |
| `/proc` missing or unlistable | `os.listdir("/proc")` raises after the installer was stopped; no `SIGKILL`, no reap | installer leads its own process group; cancel `SIGKILL`s the group |
| `/proc` an empty, unmounted directory | empty walk: the installer's child keeps running | same |
| kernel shutdown mid-install, no procfs | installer in the kernel's group | the kernel's `SIGTERM` handler kills the installer group, then exits on `SIGTERM` |

## Why

`_kill_process_tree` stops each process before listing its children, then kills every stopped one. On `main` the exception from `_child_pids` escaped between those steps, leaving the stopped installer and its child until kernel shutdown. Containers and chroots without a readable `/proc` hit this on every cancelled install, and Linux `ps` reads `/proc` too.

Decisions:
- Without procfs nothing can list processes, so the installer gets its own group (`start_new_session`) and cancel kills it. With procfs, and on macOS, the tree stays in the kernel's group as #16300 chose.
- That group misses shutdown's group `SIGTERM`, so the kernel forwards it (unblocking it if a cell blocked it) while the installer runs, and kills what the installer leaves in the group when it exits. A direct `SIGKILL` of the kernel skips this; the host sends one only after `SIGTERM` failed.
- Only the main thread can install that handler, and only it gets `SIGINT`, so a `%pip` on another thread (inside a tool call) stays in the kernel's group, where shutdown reaches it.
- `/proc` is usable only when its listing holds the kernel's own pid.

## Testing

- `PI_PYTHON_INTEGRATION=1 bun test test/core/python-runner.integration.test.ts` (Linux): 33 pass. Ten no-procfs cases: a `sitecustomize` makes `os.listdir("/proc")` raise or return `[]` and hides `ps`, a fake `ensurepip` spawns a child, then cancel or shutdown, `%pip` on the main thread or another, `SIGTERM` blocked, or a helper left running. Controls: `runner.py` from 34eb211 fails both cancel cases; without `SIGTERM` forwarding both main-thread shutdown cases fail; from 778c5a8 both other-thread ones fail; from 34baf57 the blocked and leftover ones.
- Real `/proc`-less namespace (`unshare -m`, tmpfs over `/proc`) driving `_run_installer`: 34eb211 leaves the child alive on cancel; this head kills both on cancel and on group `SIGTERM`.
- `bun run check` in packages/coding-agent passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
