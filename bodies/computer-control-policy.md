## What

I run omp on VMs where nobody sits at the screen and had no way to let it take foreground control there, so a `tools.approval["computer.control"]` entry now answers `computer.control.acquire` the way `tools.approval` answers every other approval: `allow` grants it without asking, `deny` refuses it without asking.

| `computer.control` entry | `main` | this PR |
|---|---|---|
| `allow`, no UI (subagent, `omp -p`) | `no-ui` | `{ active: true }` |
| `allow`, with a UI | asks | `{ active: true }`, no prompt |
| `deny`, with a UI | asks | `denied`, no prompt |
| `deny`, no UI | `no-ui` | `denied` |
| `prompt`, or no entry | asks, or `no-ui` | same |

```yaml
tools:
  approval:
    computer.control: allow
```

Reading order: `supervisor.ts` `controlPolicy`, then its use at the top of `#confirmControl`; tests sit next to "denies headless control" in `computer.test.ts`.

## Why

Eval prelude calls, MCP calls and tools all consult `tools.approval`, and a headless prelude call that needs approval even says "Set tools.approval.<name>: allow". `#confirmControl` answered `no-ui` whenever the session had no UI and read no setting, so a dedicated VM, CI host or benchmark machine could never hand the agent the foreground, and a user who never wants to be asked had no `deny`.

**The decision for the maintainer:** only an explicit `computer.control` entry answers. The approval mode does not: under the default `yolo`, every headless subagent would take the user's keyboard and front app while they type. `--auto-approve` and `tools.approval.computer: allow` do not either; a separate key keeps existing `computer: allow` configs, which meant "run input helpers without asking", from gaining foreground control. Reading the mode instead would be a one-line change, and is the alternative rejected here.

Unchanged: `computer.backgroundFallback: refuse` still refuses `acquire` in the worker before the host is asked, and a policy grant is revoked like an approved one (interrupt, task end, disposal). The tool prompt still describes `acquire` as asking a person: a grant or refusal reaches the model as the same `{ active }` result, so this PR leaves model-facing text alone. Like any `tools.approval` entry, it can come from a project's config as well as the user's; it is no sandbox either way, since `yolo` bash and `takeover: true` input already act without it.

## Testing

- `bun test test/tools/computer.test.ts` in `packages/coding-agent`: 126 pass. The new rows run the real supervisor and worker over a fake native session: `allow` and `deny`, each with and without a UI, assert the verdict, that no confirmation opened, and the native control state; with the supervisor change reverted, those four fail. Two boundary rows pin that `yolo` and `--auto-approve` with `computer: allow` still answer `no-ui`.
- Live, headless `omp -p` with a Haiku model on macOS, Eval calling `computer.control.acquire`: `computer.control: deny` returned `{"active":false,"reason":"denied"}`; `yolo` with only `computer: allow` returned `{"active":false,"reason":"no-ui"}`.

Not run live: `allow` on a real desktop, which takes native control of the machine running the check; the tests cover that verdict reaching the worker's native acquire.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
