## What

`find` was throwing away hits it had already verified whenever it ran out its 20 s budget, so I made it hand those back marked partial and tell the agent to narrow `path`.

When the budget runs out during verification after a hit was verified, the agent gets the verified hits plus ``partial: timed out after 20.0s with V of P passages verified; … Narrow `path` for a complete search.`` instead of a bare `find timed out after 20.0s`. An agent reported it after a broad `find`: "timed out after 20s without returning partial results or narrower-path hints".

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/4bb72c94-e418-468d-ba58-c1286b8d721b">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/36485245-364f-45b8-b813-15ec29a8ff7a">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/1f9309ef-c9b6-4bdc-a7c0-0e3a1702960c">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/ca2c9202-93f7-4d40-b571-9aea304114ed">
  <img width="780" alt="Decision flow of find's 20 s budget running out. Caller also cancelled: rejects as cancelled on main and with this PR. No hit verified yet: main errors 'find timed out after 20.0s'; this PR errors naming the phase and suggesting a narrower path. A hit verified: main errors and drops it; this PR returns the verified hits marked partial with how many of the routed passages were verified." src="https://github.com/user-attachments/assets/36485245-364f-45b8-b813-15ec29a8ff7a" />
</picture>

- **Reading order:** `CascadeOptions.deadline` and the catch around verification in `Cascade.run` (`jfind/cascade.ts`), then `FindTool.execute` (`jfind/index.ts`), then both renderers' warning in `tui/src/tools/find.ts`.
- **Non-goals:** filename or sketch scores are never returned as hits (they only route), so a timeout before any verified hit stays an error; the 20 s budget is unchanged.

## Why

Part of #14809: it also asks for a lexical-scan budget inside the 20 s, which this PR leaves alone (related: #16541 bounds those scans). On `main`, `FindTool.execute` merged the caller's signal with `AbortSignal.timeout(20_000)` and turned a deadline abort (without a caller cancel) into `find timed out`; `#dispatch`'s `Promise.all` rejected on the first aborted request, so hits from requests that had already answered were never built.

Decisions:
- The deadline is its own option, not inferred from the merged signal, because only the cascade knows whether verification had started.
- Judge calls end on the abort (`untilAborted`) and the dispatcher drains its workers before the partial result is built, so a judge answering late cannot change hits or stats already returned, and one ignoring the signal cannot hold the turn.
- A caller abort (Esc, turn abort) still rejects, even when the deadline fired in the same window.

Maintenance: a future wave that produces hits needs the same catch; `omp find` passes no deadline.

## Testing

- `jfind.test.ts` "returns the hits verified before find's deadline, marked partial": through `FindTool.execute`, `a.ts` answers, the deadline fires while `b.ts` is in flight, `c.ts`'s judge ignores the abort and answers after the call returned. `main`: `find timed out after 20.0s`. This PR: hits `[a.ts]`, `timeout {1, 3}`, stats unchanged after `c.ts` answers.
- "names the interrupted phase …" fails on `main`; "rejects a caller abort … deadline fired too" fails with the guard removed; `find-render.test.ts` checks the ANSI and native warning.
- Live, real judge over `packages/coding-agent/src`, deadline fired 230 ms into verification: 8 hits, `25 of 40 passages verified`.
- Agents, 3 runs per cell, task "which line decides a find hit?" on a copy of `packages/coding-agent/src`, deadline fired after the first verification answer:

| | Haiku 5.5 | GPT-6.1 Sol |
|---|---|---|
| `main` (error) | 3/3 correct · 5.7 tool calls · find retried in 1 | 3/3 · 5.3 calls · retried in 2 |
| this PR (partial hit) | 3/3 · 2.7 calls · no retries | 3/3 · 2.7 calls · no retries |

<details><summary>Behaviour-run details</summary>

Headless `omp -p --no-session --mode json --thinking low`, one fresh fixture per run; both arms used a harness that fired the deadline once the first verification request answered. In one Sol run on this PR a single request answered every routed passage, so that call completed with no timeout. Every partial result's hit was `cascade.ts` (0.97–0.98). Cost: Haiku $0.017 → $0.005, Sol $0.159 → $0.104 for the three runs.
</details>

`bun test test/tools/jfind.test.ts` (packages/coding-agent), `bun test test/find-render.test.ts` (packages/tui), `bun run check:ts`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
