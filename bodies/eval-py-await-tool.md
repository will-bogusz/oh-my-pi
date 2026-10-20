## What

I made the `eval` tool's prelude listing say `await tool.<name>(args)` for Python-only sessions too, since the Python tool proxy is async and a bare call never runs the tool.

With `eval.js` off, the model was told:

```diff
 Sync; kwargs.
 ...
-tool.<name>(args) — session tool; `args` is its parameter object
+await tool.<name>(args) — session tool; `args` is its parameter object
```

Sessions with JS enabled already rendered `await`; their text is unchanged.

## Why

`_ToolCallable.__call__` in `src/eval/py/prelude.py` is `async def`, so `r = tool.read({...})` without `await` binds a coroutine: the cell prints `<coroutine object …>`, Python warns that it was never awaited, and the read never happens. The template only added `await` under `{{#if js}}`, so a Python-only session was taught the call that silently does nothing. `docs/tools/eval.md` already says tool calls are async in both runtimes.

Non-goals: the Python file helpers (`read`, `write`, `output`) stay synchronous and their wording is unchanged.

## Testing

| `PI_JS=0`, Haiku 5.5, "use `tool.read` in one Python cell to read /etc/hostname" | runs that first got a coroutine | eval calls per run |
|---|---|---|
| `main` | 2 / 2 | 2 (retried with `await`) |
| this PR | 0 / 2 | 1 |

- `test/tools/eval-description.test.ts` gains a case that every runtime combination renders `await tool.<name>(args)`; it fails on `main` (Python-only) and passes here, with the other 9 cases unchanged.
- Direct check on `main`: a Python cell `r = tool.read({'path': ...}); print(r)` printed `<coroutine object __omp_with_call_site__ …>`.

```
cd packages/coding-agent && bun test test/tools/eval-description.test.ts
```

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
