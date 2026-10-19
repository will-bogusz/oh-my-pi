## What

My omp logs under Tern kept filling with the same warning every 5 seconds whenever Tern stopped acking frames, so I made it warn once per stall and say how long the stall lasted when acks come back.

A stall spanning N credit resets goes from N warnings on `main` to 2 lines: the warning when the stall begins, and a debug line when an ack ends it.

| Stall length (5 s resets) | `main`: log lines | This PR: log lines | Frames sent (both) |
|---|---|---|---|
| 1 | 1 warn | 1 warn + 1 debug | 3 |
| 4 | 4 warn | 1 warn + 1 debug | 9 |
| 16 | 16 warn | 1 warn + 1 debug | 33 |
| 100 | 100 warn | 1 warn + 1 debug | 201 |
| 1,000 | 1,000 warn | 1 warn + 1 debug | 2,001 |

The end line carries `stalledMs` (from the oldest unanswered frame to the ack) and `resets`, so nothing the repeated lines told you is lost. Credits, the 5 s stall threshold and the frames sent are unchanged.

## Why

`NativeBackend.#hasCredit` drops the credit count once the oldest unacked frame is 5 s old and logs `TSP: terminal stopped acknowledging frames; resuming without credits`. With a terminal that stays silent, the next two frames stall again 5 s later and log again, with no record that the previous stall never ended. In my omp logs this one warning was 30,328 lines across 18 Tern processes; one process wrote 16,174 in a row without a single ack between them, and it still fills about half of a recent 18.12.1 log.

Decisions:
- The per-reset lines are dropped rather than demoted to debug. The file transport keeps debug by default (`OMP_LOG_LEVEL` unset), so debug repeats would leave the file just as long.
- The stall state lives on `Surface` next to `unacked`, and `resume()` clears it with `unacked`, so a stop/start cycle never reports the editor's time as a stall.
- The end line is debug, matching the file's other non-error TSP lines.

Non-goals: why Tern stops acking, and the 2-frames-per-5-s rate during a stall.

Related: #16015 (an OOM report that quotes the same warning; this PR changes only the logging).

## Testing

- `bun test test/native/backend.test.ts` (packages/tui): new case "warns once for a stall that spans several credit resets, then logs how long it lasted when acks return" drives `TspHarness` with a terminal that never acks for 4 stall periods, then acks, and reads the log through `registerLogSink`. It expects one warn and one debug line with `stalledMs: 20000, resets: 4`. With the `backend.ts` change reverted it fails with 4 warnings and no end line. 10/10 pass with the change; the 149 tests in `test/native` pass.
- The table comes from the same harness run for 1, 4, 16, 100 and 1,000 stalls on `main` and on this branch, counting every `TSP:` log event and the frames the terminal received.
- `bun run check` (packages/tui) passes.
- Not run: a live Tern session that stops acking; I have no way to make Tern stall on demand.
