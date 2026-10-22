## What

I wanted my scripts to be able to tell a running omp session something, like "the nightly build finished, check the report", without me switching to that terminal and typing it in.

`omp poke <session> <message>` now delivers a message into a session exactly once, whether that session is idle, mid-turn, interrupted with Esc, or closed.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/c3661e3b-da8b-45c7-a91d-f3c76286bc4a">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/40eb1401-ec1d-4279-8dd3-9adf84944ef4">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/b8e0a655-93d2-4f1d-97fa-fe799fb2ee70">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/8f0ee470-73d0-4931-ac15-032a986fb28f">
  <img width="780" alt="Decision flow for omp poke. Session not open in any omp: the message is held until opened by a process that delivers mail; --resume requests a headless turn in the session's own file. Open only where mail is not delivered (an SDK host without mailbox.deliver, OMP_MAILBOX=0, or an older omp): held, never resumed headless. The user pressed Esc and the poke has no --force: it waits and goes in ahead of the user's next message. Otherwise a busy session takes it at its next step; an idle session starts a turn unless its ACP client defers agent turns until the next prompt." src="https://github.com/user-attachments/assets/40eb1401-ec1d-4279-8dd3-9adf84944ef4" />
</picture>

> **Context.** *Presence*: every process that opens a saved session drops a lock-guarded file saying so, removed when it closes. *Mailbox*: a maildir per session under `<agentDir>/mailbox/`; a message is claimed by one rename and counts as delivered once its id is in the session file.

SDK hosts opt in with `createAgentSession({ mailbox: { deliver: true } })`; by default an embedded session only announces itself, so a poke for it is held.

Reading order: `mailbox/mailbox.ts` → `mailbox/presence.ts` → `mailbox/watcher.ts` → `agent-session.ts` (`onClosed`, held mail in `prompt()`) → `mailbox/headless.ts` + its guard in `main.ts` → `cli/poke-cli.ts`.

## Why

Nothing outside a session can reach it today: a build script or CI hook waits for you to relay its result by hand. This gives scripts one command, and gives scheduled wakes (#2763, #8757) a delivery path that also works when the session is closed. Related: #14263 (opt-in agent-to-agent messaging between live sessions); #10363, #8077.

Decisions:
- **Files, not a socket**: a maildir also serves a closed session and survives a crash; a claim that never reached the session file goes back to the queue (3 attempts at most).
- **One consumer per session**: an exclusive lock across processes and session managers.
- **Presence at open, write lease only when mail waits**: opening a session keeps `main`'s first-writer rule.
- **Never resume headless while another process has the session open**: that turn would land on a branch it never sees. The headless host re-checks before its first write and exits 75.
- **Esc wins**: a poke after Esc waits for your next message; `--force` overrides.

The one decision for the maintainer: an outside process of the same user may start a turn in a live session (and, with `--resume`, in a closed one).

Maintenance: relies on `rename(2)` and `tryAcquireFileLock`; if lock semantics changed, `poke` would say `held` instead of `live` and `mailbox.test.ts` fails. Non-goals: notifications for held pokes, delivery across hosts, access control beyond file permissions.

## Testing

Live, from this branch with claude-haiku-4-5: real RPC, TUI, print, ACP and SDK hosts, `omp poke` as a separate process, isolated `OMP_MAILBOX_DIR`: 62 of 62 checks passed.

<details><summary>Telling lines from the run log</summary>

```
PASS [idle] idle session starts a turn on its own — agent_start=1 customType=session-poke
PASS [stream] poke joins the running turn at a step boundary (no second turn) — agent_start=1
PASS [esc] held poke enters ahead of the user's next message, same turn
PASS [resume] no sibling session file — 4 → 4
PASS [foreign] headless host started on a session another process has open exits 75 without writing — entries 9→9
PASS [crash] stranded claim returns to new/ on reopen and is delivered — landed 1.0 s after the reopen
PASS [lease] opening a saved session leaves its write lease free
PASS [race] three concurrent pokes, two watchers: each delivered exactly once — 1,1,1; turns a=1 b=0
PASS [race] when the owner closes, the other process takes over delivery
PASS [modes] ACP: the client's next prompt carries the poke in, delivered once
```

</details>

`bun test test/mailbox.test.ts test/session-mailbox.test.ts`: 18 pass; the eight tests for the review fixes each fail with their fix reverted. `bun run check:ts` at the root.

<details><summary>What the unit tests cover</summary>

Claim-once across 4 racing processes; the live / held / free ladder incl. a dead holder and an older omp holding the write lease; an idle session starts a turn; after Esc a `--force` poke goes in at once while a plain one waits and is sent ahead of the next user message; a busy prompt takes no mail; one consumer among two managers in a process; no claim while extensions load across `/new`; a dead consumer's claim delivered once on reopen; no `done` while the session file is unwritable; presence gone after dispose, also when close fails; the write lease stays free on open; an ACP client with agent turns off gets the poke with its next prompt.

</details>
