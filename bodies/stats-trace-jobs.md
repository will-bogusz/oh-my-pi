## What

The Traces tab never noticed a background job finishing, because it waited for an entry the agent never writes, so I made it close jobs from the entries that actually land in the transcript.

On a real session with 29 subagents, Idle goes from 0.00s to 603h and the longest turn bar from 669h to 55 min.

<img width="1215" alt="Traces tab for one real session on main (Idle 0.00s, every bar runs to the session end) and on this PR (Idle 603h, turns and jobs end with their work)" src="https://github.com/user-attachments/assets/65323b1d-73f8-4c44-ab51-43b5a83dae7a" />

A background span now ends at the first of these, whichever the transcript holds:

- the job's async-result delivery, saved as a `custom_message` entry;
- a `wait` result that lists the job with a settled status (`completed`, `failed`, `cancelled`), since a `wait` that hands a job over suppresses its delivery;
- a proc:// kill result, which reports the cancelled job under `details.proc.jobs` and also suppresses the delivery.

A job none of these ever reports (still running when its subagent exited, or in a live session) stays open to the track's last entry, as before. A status that only reports, such as a proc:// roster read or another tool's own `jobs` list, does not close anything, since the delivery still follows it.

`TRACE_ETAG_VERSION` goes to 6, so an open dashboard revalidating an unchanged transcript gets the corrected trace instead of a 304.

## Why

`scanTranscript` in `packages/stats/src/trace.ts` skipped every entry that is not a `message` and closed a job only on a `message` with role `custom` and type `async-result`. `SessionManager.appendCustomMessageEntry` saves deliveries as `custom_message` entries instead; none of 4,150 real transcripts with a delivery holds the shape the builder looked for. So every background span ran to the end of the transcript, every turn span absorbed it, and Idle (wall time minus covered time) came out 0. The test fixtures used the never-saved shape, which is why they passed. The HTML export's trace view goes through the same builder and is fixed with it.

Wall time can shrink too: it ends at the last real span instead of at a trailing `session_exit` that an open job stretched to (669h to 605h above).

## Testing

`packages/stats/test/trace-builder.test.ts` now builds its deliveries in the saved `custom_message` shape and adds a session where one job closes through `wait`, another through a proc:// kill, and an unrelated tool's matching `jobs` entry closes nothing; it asserts each span's end, both turn ends and the idle time. With the `trace.ts` change reverted, 4 of its 14 tests fail; with it, all pass. `bun run check` in `packages/stats` passes.

Live, `buildSessionTrace` on three real transcripts, `main` against this branch:

| Session | Idle | Background spans left open | Longest turn |
|---|---|---|---|
| 29 subagents, 887 requests | 0 → 603.0h | 17/17 → 0/17 | 669.2h → 0.9h |
| 2 subagents, 605 requests | 0 → 6.4h | 4/4 → 1/4 | 7.1h → 0.5h |
| 3,004 background jobs | 0 → 16.5h | 3,004 → 19 | 191.0h → 32.1h |

The spans still open are jobs no entry ever reports finished: still running when their subagent exited, or tasks of a session that was live during the run (its 32h longest turn is the turn still in progress). The same numbers came back from `/api/session/trace` on a dashboard served from each tree.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
