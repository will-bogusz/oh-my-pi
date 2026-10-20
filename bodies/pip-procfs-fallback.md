## What

Follow-up to #16300: Codex pointed out after the merge that cancelling `%pip` breaks on Linux hosts without a usable `/proc`, so I made the process walk fall back to `ps` there instead of raising.

Cancelling `%pip` with `/proc` unlistable: installer left stopped (`SIGSTOP`) and its child running → both killed and reaped.

| Linux host | `main` | This PR |
|---|---|---|
| `/proc` mounted | children read from `/proc/<pid>/stat` | unchanged |
| `/proc` missing or unlistable, `ps` works | `os.listdir("/proc")` raises after the installer was stopped; no `SIGKILL`, no reap | children listed with `ps -A -o pid=,ppid=`, the path macOS already takes |
| `/proc` an empty, unmounted directory, `ps` works | empty walk: the installer is killed, its child keeps running | same `ps` fallback |
| No usable `/proc` and no working `ps` | raise, or empty walk | no children found: the installer itself is killed and reaped |

## Why

`_kill_process_tree` stops each process before listing its children, then kills every stopped one. On `main` the exception from `_child_pids` escaped between those two steps, and the eval still returned cancelled while the stopped installer and its child stayed in the kernel's process group until kernel shutdown. Containers and chroots without a mounted or readable `/proc` hit this on every cancelled install.

Decisions:
- Reuse the existing `ps` branch rather than add a separate kill-only fallback; it already returns an empty map when `ps` fails, which leaves just the installer to kill.
- `/proc` counts as usable only when its listing holds the kernel's own pid, which tells a mounted procfs from an empty mountpoint without parsing mount tables.

## Testing

- `PI_PYTHON_INTEGRATION=1 bun test test/core/python-runner.integration.test.ts` (packages/coding-agent, Linux): 25 pass. Two new cases, `cancelling %pip stops the installer tree when /proc cannot be listed` and `... when /proc is an empty, unmounted directory`: a `sitecustomize` makes `os.listdir("/proc")` raise `PermissionError` or return `[]`, a fake `ensurepip` spawns a child, and the cell is cancelled. With `runner.py` reverted to `main` both fail with the installer's pids still running.
- `bun run check` in packages/coding-agent passes.

Not run: a host with `/proc` actually unmounted (user namespaces are disabled on the Linux box I have); the injected listings take the same branches.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

