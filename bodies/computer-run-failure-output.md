## What

I kept the text and screenshots from a failed computer run so an agent can see what happened before the error.

JavaScript and Python Eval now show partial computer output and still raise the failure, preserving its message and JavaScript error name. The Eval status line shows the error, not the captured output.

## Why

A computer script can act, capture the result, then fail on its next step. Previously that failure discarded every screenshot and printed observation, leaving the agent without the evidence needed to decide what to do next.

Worker-reported failures with output now return that output alongside the error instead of rejecting before rendering. Empty-output failures, user cancellation, and worker crashes keep their existing error path. No native input behavior changes.

Review the worker result and supervisor Escape handling first, then the shared output renderer and the two Eval facades. Failure reporting does not read native capabilities, which can block after a hung native call.

## Testing

On macOS, the real worker, supervisor and both Eval bridges ran over a fake native desktop: print `MARK`, take a screenshot, then throw `TypeError('stop after act')`. Both cells retained the marker and image and still failed with the original message. A separate worker test checked screenshot metadata; the Escape test checked that wrapping the error retained output.

With production changes reversed to main, all four original regression tests failed. The independent review's partial-abort regression also failed against the reviewed head, then passed with the correction. With the fix, all 150 computer tests passed:

```sh
cd packages/coding-agent
bun test test/tools/computer.test.ts
```

`bun run check:ts` passed (existing lint warnings only). No model or real desktop input was needed.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (added when the PR opens)
