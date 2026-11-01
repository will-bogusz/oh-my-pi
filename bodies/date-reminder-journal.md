## What

there was an earlier session where we looked into weird anthropic refusals and how to keep reasoning quality maintained, some finding about token labels and similar, may be worth figuring out and looking back into to increase quality as well.

Resuming a session, or waking a parked subagent, on a later day made Claude lose every earlier thinking block: omp resent the first message with today's date, so Anthropic dropped all thinking signed after it and the cache stopped at the system prompt. Now each message keeps the date it was first sent with.

| Live check, Haiku 5.5 with thinking | `main` | this PR |
|---|---|---|
| Main session resumed the next day | 2 of 2 thinking blocks dropped; cache read 29,984 (system + tools) | 0 dropped; cache read 30,779 (whole history) |
| Subagent parked, woken by IRC after midnight | 2 of 2 dropped; cache read 27,470, 1,675 written | 0 dropped; cache read 29,016 |

The date/cwd line rides on the first user message (#7404). `DateCwdReminderInjector` remembered each message's date only in memory, and a resume, a revived subagent or `/resume` gets a new injector.

Reading order: `session/date-cwd-reminder.ts` (`DateCwdReminderJournal`, `#restoredRootState`, the `record` calls), then `sdk.ts`.

## Why

Over one week of my sessions on 18.14.0 this caused 144 of the 406 requests sent with thinking dropped (`inputTransformations: prefix_binding_mismatch`), mostly subagents woken overnight.

Each placement is recorded as a `date-cwd-reminder` custom entry (`{ conversation, turn, reminder, placement }`), and an injector meeting a conversation it has no state for rebuilds its reminders from the branch: so fork, branch switch, compaction and `/resume` see the right set.

- After a compaction renumbers same-key turns, the new conversation journals what it inherits under the new keys.
- A first message a context hook rebuilds every request is found again by a digest of its content.
- The branch is read once per resume, not per request. A turn recorded without a reply (an interrupted request) counts as sent. Switching sessions or moving in the tree drops the in-memory state, and placements before `/clear` are not read back.
- Rejected: dating the first message from its timestamp (#15364's first version); it cannot place a later reminder (mid tool loop, after `cd`).
- Advisors keep unjournaled injectors. Older transcripts keep `main`'s behaviour.

## Decisions

- This PR or #15364: this one. #15364 edits the injector as it was before #17117 reworked it and has conflicted since 10-21; this PR implements the contract #15364's review settled on (a custom entry read back from the branch) on the current injector, so #15364 can close if this merges.

## Testing

- `bun test test/date-cwd-reminder.test.ts`: 42 pass. 9 of 10 new tests fail on `main`; the other (a compaction dropping a developer reminder's anchor) fails against a journal keyed by original turns. They cover a fresh injector resending earlier turns byte-for-byte, compaction, a re-created first message, journal reads, and a file-backed session reopened two days later.
- Live, real Anthropic, Haiku 5.5 (same thinking binding as Opus 5.5), request bodies dumped before sending: the table.
- Full `packages/coding-agent` suite: failures match `main`'s.

Closes #15343

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
