## What

My agents kept getting the old file back when they regenerated something with bash and read it in the same message, so now the read checks whether that bash changed the file and reads it again, without making any call start later.

A `read` placed after a `bash` call in one assistant message returned the file as it was before the command ran: `1:old` on `main`, `1:new` with this PR.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/b39e52f8-17cd-49af-b9a4-b5ec2bd1dd2e">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/bd35ba00-c0a7-4fab-b4b3-36a8599687f5">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/41b47b53-a8fa-4fd8-951e-70752978edd0">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/38c2697f-666d-4ea0-838f-fd8411fdd982">
  <img width="780" alt="Timeline of one message with bash 'sleep 0.5; echo new > f' then read f. Both calls start at 0 ms on main and on this PR. On main the read returns '1:old' at 6 ms. On this PR the read also reads at once, holds its result until bash ends (538 ms in this PR's run), sees f changed, reads again and returns '1:new' 1 ms after bash ends." src="https://github.com/user-attachments/assets/bd35ba00-c0a7-4fab-b4b3-36a8599687f5" />
</picture>

- The agent loop hands each call `ctx.toolCall.earlierEffectsSettled`, a promise for the earlier calls of its message that run beside it and may write (any approval tier but `read`: `bash`, `task`, MCP tools; not `read`, `grep`, `glob`).
- `read` fingerprints every local path it may resolve to (identity, size, times, a hash up to 1 MiB, a SQLite `-wal` sidecar, two listing levels), reads, waits for that promise, and reads again unless its result came from a fingerprinted path that did not change. Errors, suffix matches, `;` lists and IDA views (an IDA edit changes the open database, not the file) always read again. A web URL fetches again only if a local `;` part it names appeared or changed.
- The second read runs inside the tool, so approval prompts and extension hooks fire once; an abort during the wait rejects the read.

## Why

Non-pty `bash` runs beside other calls on purpose. A read after it starts together and usually finishes first. The model sees a batch's results only after every call ends, so the read can check its file then; no call starts later.

Rejected, replayed over 30,455 recorded multi-call batches:
- Ordering `bash` against other calls: +0.33% (bash keeps its call-order place) to +1.04% (bash exclusive) of batch time, since every read, grep and web search beside a bash starts later.
- Waiting in `read` for the earlier calls, then reading (tried on an earlier head): +90 s, about this PR's likely bound, but all 3,708 reads beside a writing call start late and 1,746 batches slow down, against 337–1,435 here.

Not covered, as on `main`: a read placed *before* a bash; internal URLs (`local://`, `skill://`); writes by a bash call after it moves to the background; `grep`, `find`, `lsp`.

## Testing

- Live (Haiku 5.5; `bash "sleep 0.5; echo new > f"` then `read f`, both starting within 1 ms): `main` returned `1:old` 6 ms in; this PR `1:new` 2 ms after bash ended (535 ms).
- `packages/coding-agent/test/tools/read-after-bash.test.ts` runs the real tools through the agent loop, bash changing the target only after the read returned: a rewritten, created and deleted file, `file://`, a suffix match, a tar member, SQLite (also WAL with another connection open), directory entries two levels in and past 2,000, a curly-quote fallback, the cwd, web URLs (`;` in a query fetched once; split from a new file; a rewritten local or `local://` part), an IDA view, an abort. With `read.ts` from `main` 17 of 20 fail.
- `packages/agent/test/agent-loop.test.ts`: only a call beside an earlier writing call gets the promise, settled after it; a transform that makes a call write counts, transforming once.
- `bun run check` and `bun test` in `packages/agent` (801 pass); `bun run check` and the read, IDA and fetch suites in `packages/coding-agent` (227 pass).

<details><summary>Replay cost and method</summary>

2,938 local reads ran beside an earlier writing call, so they were fingerprinted twice: 0.05 ms for a 20 KB file, 0.16 ms for 1 MiB. Re-reading the 482 whose path an earlier bash command names adds 93 s in all (0.017% of batch time); re-reading all 2,938 adds 180 s (0.033%). Waiting instead adds 90 s (0.017%).

Every assistant message with two or more tool calls in one machine's recent omp sessions (30,455 batches, 149.9 h of batch time), replayed with each call's recorded duration through `main`'s scheduler (within 2 ms of the recorded batch time at p90), then under each policy. Which files changed can't be read from the logs, so re-reads are bounded: reads whose file name appears in an earlier bash command of the same group, and every local read beside an earlier writing call.

</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
