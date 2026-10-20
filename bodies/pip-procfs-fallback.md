## What

Follow-up to #16300: Codex pointed out after the merge that cancelling `%pip` breaks on Linux hosts without a usable `/proc`, so I made the process walk fall back to `ps` there instead of raising.

Cancelling `%pip` without procfs: installer killed, its child left running → the whole installer tree killed and reaped, on cancel and on kernel shutdown.

| Linux host | `main` | This PR |
|---|---|---|
| `/proc` mounted | children read from `/proc/<pid>/stat` | unchanged |
| `/proc` missing or unlistable | `os.listdir("/proc")` raises after the installer was stopped; no `SIGKILL`, no reap | installer leads its own process group; cancel `SIGKILL`s the group |
| `/proc` an empty, unmounted directory | empty walk: the installer is killed, its child keeps running | same own-group kill |
| kernel shutdown mid-install, no procfs | — (installer is in the kernel's group) | the kernel's `SIGTERM` handler kills the installer group, then lets `SIGTERM` take the kernel down |

## Why

`_kill_process_tree` stops each process before listing its children, then kills every stopped one. On `main` the exception from `_child_pids` escaped between those two steps, and the eval still returned cancelled while the stopped installer and its child stayed in the kernel's process group until kernel shutdown. Containers and chroots without a mounted or readable `/proc` hit this on every cancelled install. Linux `ps` reads `/proc` too, so it cannot list the children there either.

Decisions:
- Without procfs nothing on Linux can list processes, so the installer gets a process group of its own instead (`start_new_session`) and cancelling kills that group. With procfs, and on macOS, the tree stays in the kernel's group as #16300 chose.
- A separate group no longer gets kernel shutdown's group `SIGTERM`, so while such an installer runs the kernel forwards `SIGTERM` to it. A direct `SIGKILL` of the kernel mid-install skips that forwarding; the host only sends one after `SIGTERM` failed.
- `/proc` counts as usable only when its listing holds the kernel's own pid, which tells a mounted procfs from an empty mountpoint without parsing mount tables.

## Testing

- `PI_PYTHON_INTEGRATION=1 bun test test/core/python-runner.integration.test.ts` (packages/coding-agent, Linux): 27 pass. Four no-procfs cases: a `sitecustomize` makes `os.listdir("/proc")` raise `PermissionError` or return `[]` and hides `ps`, a fake `ensurepip` spawns a child, and the cell is cancelled or the kernel shut down. With `runner.py` from the previous head both cancel cases fail with the child still running; with the `SIGTERM` forwarding removed both shutdown cases fail.
- Real `/proc`-less namespace (`unshare -m`, tmpfs over `/proc`) driving `_run_installer`: previous head leaves the child alive on cancel; this head kills installer and child on cancel and on group `SIGTERM`. Without forwarding, `SIGTERM` leaves both alive.
- `bun run check` in packages/coding-agent passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
