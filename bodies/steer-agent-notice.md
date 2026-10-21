## What

When I tagged a model with `^` while the agent was busy, the model got the "m1 is now available" notice as a turn of its own and answered it before it ever saw my message; this keeps the two together.

A steered or follow-up message with a `^` mention now reaches the model in one turn, notice included. The session-agent notice counts as a hidden companion of the prompt it precedes, so one-at-a-time steering dequeues them as a group, and removing, promoting or clearing that queued message takes the notice with it.

## Why

Fixes #14093. #14322 made a mid-stream mention queue the notice ahead of its message, but the queue keeps a hidden notice with its prompt only when `isHiddenUserCompanion` recognizes it, and that check required `attribution: "user"` and a fixed list of types. The notice is agent-attributed, so it was dequeued alone. In a real session it cut a running `wait` short, the model replied to the notice, and the message asking it to use the tagged model arrived on the following turn.

The check matches the notice by type rather than re-attributing it to the user. Flipping its attribution would change how providers render it: Anthropic keeps user-attributed developer turns off system authority, and Ollama sends them as `user`. The notice is only ever queued directly before the prompt that minted the alias, so matching on its type cannot pull in an unrelated message. A notice removed with its message is rebuilt on the next prompt, because `takeSessionAgentNotice` derives it from what actually reached the context.

The idle-prompt path already sends the notice in the same request and is unchanged.

## Testing

- The #14093 test in `agent-session-aside-delivery.test.ts` now also asserts that the steer takes two model calls and that the second carries both the notice and the steer text. With the source change reverted it fails with three calls.
- Live RPC run on `claude-haiku-5-5`: a `sleep 6` bash turn, steered mid-tool with `if you get stuck, hand it to ^anthropic/claude-haiku-5-5`. On `main` the transcript records the notice, an assistant turn, then the user message. On this branch the notice and the user message are recorded back to back and answered in one turn.
- `bun test test/agent-session*.test.ts test/session` in `packages/coding-agent`: 2311 pass. The 3 failures in `agent-session-message-pipeline` ("No API key found for ollama") fail the same way on `main`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
