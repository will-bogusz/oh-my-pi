## What

A script the agent runs through `bash` can't find its own session: `PI_SESSION_FILE` is set for `eval` cells only, so `echo "$PI_SESSION_FILE"` prints an empty line, and a tool that reads it fails. Our recorded sessions show 50 such failed `bash` calls in 49 sessions, 46 of them subagents.

Every `bash` command now gets `PI_SESSION_ID` and `PI_SESSION_FILE` for the session running it: foreground, background jobs, PTY, ACP client terminals and `name` services. The values are read when each call starts, so the next call follows `/fork`, `/new` and `/resume`, and a subagent gets its own transcript.

Supersedes #14729 by @johnrichardrinehart, which has had no activity since 10-07 and conflicts with main. It carries their commit, rebased onto main, and adds:

- **Main's two changed call sites kept.** The conflict in `bash.ts` was main's new `sessionKey`/`isSessionCurrent` lines next to the added `env`; both are kept.
- **The call's own session.** `main` captures the session ID before the first await so a call that waits across a `/fork` keeps its shell; #14729 read the identity later, so such a call ran in the old shell with the fork's ID and file. It is now read alongside the ID.
- **An absolute path.** With a relative `--session-dir` the session file is relative too, so a command that `cd`s elsewhere couldn't open it; it is now resolved.
- **Tests for the two paths #14729 changed without one** (background jobs, `name` services), and its foreground test now seeds the stale value in the session's shell: it passed with `PI_SESSION_FILE` dropped.
- Its CHANGELOG entry moved to `[Unreleased]` (the cherry-pick had put it, and a stale line around it, in 18.12.3); `docs/tools/bash.md` names both variables.

## Why

- **Per-run `env`, not the shell's session env.** The embedded shell keys its persistent session on its env (where `PI_GIT_GUARD` sits); per-run values set the variables without starting a new shell when they change.
- **Always set, empty when not persisted** (`--no-session`): an env overlay can't unset, so an empty value replaces one inherited from a parent omp.
- `PI_SESSION_ID` comes from the session manager, so an advisor sees the real session id, not its `-advisor` tool-state key.

Non-goal: user `!` commands, which aren't the agent's.

Reading order: `tools/bash.ts` (`#sessionEnv` and its four call sites) → `launch/services.ts` (`env` overlay) → `docs/environment-variables.md`.

## Testing

Live, headless `omp -p` (Haiku 5.5), parent and one subagent each running `cd / && echo "file=[$PI_SESSION_FILE] id=[$PI_SESSION_ID]" && test -f "$PI_SESSION_FILE"`, with `--session-dir ./sess`:

<details><summary>Output, main vs this PR</summary>

| build | parent | subagent |
|---|---|---|
| main 53a0377db6 | `file=[] id=[]`, exit 1 | `file=[] id=[]`, exit 1 |
| this PR | `file=[/…/sess/2026-10-19T20-44-38-073Z_01a155e8-bb39-….jsonl] id=[01a155e8-bb39-…]`, file exists | `file=[/…/sess/2026-10-19T20-44-38-073Z_01a155e8-bb39-…/EnvProbe.jsonl] id=[01a155e8-c80b-…]`, file exists |

Before the path fix the parent's value was `sess/2026-…jsonl`, relative.

Removing each call site's `env` fails its test: foreground (`bash-failure-result.test.ts`), background job (`bash-job-lifecycle.test.ts`), ACP terminal and PTY preflight (`bash-acp-terminal.test.ts`), `name` service (`launch/service-completion-ownership.test.ts`). Reading the identity late fails the paused-call test (session switched while the call waits on its artifact); dropping only `PI_SESSION_FILE` fails the stale-shell test; dropping `path.resolve` fails the background-job test.

</details>

`cd packages/coding-agent && bun test test/bash-failure-result.test.ts test/bash-job-lifecycle.test.ts test/bash-acp-terminal.test.ts test/launch/service-completion-ownership.test.ts`

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution
