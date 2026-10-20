## What

My agents kept reading `proc://<id>/kill` to stop a job, got a one-line refusal that didn't say what to do instead, and about half of them just moved on with the job still running, so the error now spells out the exact write call.

Reading `proc://<id>/kill` or `proc://<id>/mode` still refuses and still never acts (reads can be speculative); only the message changes:

```diff
- proc://<id>/kill is writable only
+ proc://bg_12/kill is write-only; reading it did not stop anything. To cancel bg_12, call write with {"path":"proc://bg_12/kill"} (no content needed); read proc://bg_12 for its status.
```

```diff
- proc://<id>/mode is writable only
+ proc://bg_12/mode is write-only. To set a service's mode, call write with {"path":"proc://bg_12/mode","content":"persist"} (persist, session, or detached); read proc://bg_12 for its current mode.
```

The old text printed a literal `<id>` and named neither the `write` tool nor the job. The new wording follows the existing `stdin is only available for services. To cancel, call write with {...} (no content needed).` error in the same file's write handler.

## Why

Over 20 days of my sessions, 35 `read proc://<id>/kill` calls from about 30 agents got the old error. 16 followed up with `write proc://<id>/kill`; the other 14 moved on and the job kept running.

Non-goals: making a read of `/kill` cancel (a read must stay side-effect free), and any change to the write paths.

## Testing

- `proc-service.test.ts`: new test `answers a read of a write-only action with the write that performs it, leaving the job running` checks both messages name `call write with`, the real id and path, and that the job is still running after the read. The existing `lists owned jobs, preserves delivery on read, and scopes kill to the owner` now asserts `write-only`.
- Negative control: with `origin/main`'s `proc-protocol.ts` restored, both tests fail (21 pass, 2 fail); with the change, 23 pass.
- Real tool path: a `ReadTool` read of `proc://bg_12/kill` and `/mode` returns the messages above with the job still `running`; then `WriteTool` with exactly `{"path":"proc://bg_12/kill"}` reports `Cancelled (1)` and the job is `cancelled`.
- `bun run check` in `packages/coding-agent` passes.

```sh
bun test packages/coding-agent/test/tools/proc-service.test.ts
```

---

- [ ] `bun check` passes (ran `bun run check` in `packages/coding-agent` only)
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
