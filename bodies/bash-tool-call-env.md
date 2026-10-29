## What

I want a script the agent runs to be able to say which tool call ran it, so a log entry it writes can point straight at that call in the transcript instead of just the session.

`echo "$PI_TOOL_CALL_ID"` in a `bash` call printed an empty line; it now prints the id of that call, the same `toolu_…` id the session transcript records for it.

Every `bash` command gets `PI_TOOL_CALL_ID` next to `PI_SESSION_ID` and `PI_SESSION_FILE`, on the same routes: foreground, background jobs, PTY, ACP client terminals and `name` services. Like those two it is always set, so a value inherited from a parent omp or exported by an earlier command in the persistent shell is replaced.

## Why

`PI_SESSION_FILE` tells a script which transcript it is in, not where: a session has hundreds of calls, so a tool that logs what it did (an audit trail, an ops ledger) can only point at the whole file. With the call id, a reader goes straight to the `toolCall` entry and its result.

- **Per-run `env`, like the session identity.** The id rides in the same object `#sessionEnv` already builds per call, so it never keys a new shell and needs no new plumbing.
- **`bash` only, not `eval`.** The Python kernel applies its managed variables to the process-wide `os.environ` and can run more than one execution at a time, so a per-call id there could belong to another cell; the JS kernel takes no per-call env at all. Giving `eval` cells their own id needs a per-execution channel, which is a separate change.

Non-goals: user `!` commands (not tool calls). A `bash` call made from an `eval` cell through the tool bridge gets the bridge's generated `js-bash-…` id, which no transcript entry carries (the transcript records the `eval` call); the docs say so rather than substituting the `eval` call's id, which would give every bridged call in a cell the same one.

Related: #11959 (sessions and agents have no identity their tools can reference).

Reading order: `tools/bash.ts` `#sessionEnv` and its one caller in `execute` → `docs/environment-variables.md`.

## Testing

Live, headless `omp -p` (Haiku 5.5), the model asked to run `echo "tool_call_id=[$PI_TOOL_CALL_ID]"`:

| build | printed | transcript `toolCall` id |
|---|---|---|
| main | `tool_call_id=[]` | `toolu_013M4pxyeW9wuwR5zZmT3rzW` |
| this PR | `tool_call_id=[toolu_01KSsRePNaRtVk3QTKsnLrKb]` | `toolu_01KSsRePNaRtVk3QTKsnLrKb` |

Each route's existing session-identity test now also asserts the call id equals the id the call ran with: foreground (two calls in one shell after a stale `export PI_TOOL_CALL_ID=…`), background job, ACP terminal, `name` service. With `bash.ts` reverted all four fail.

`cd packages/coding-agent && bun test test/bash-failure-result.test.ts test/bash-job-lifecycle.test.ts test/bash-acp-terminal.test.ts test/launch/service-completion-ownership.test.ts`

- [x] `bun check` passes (`check:ts`; Rust unchanged)
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution
