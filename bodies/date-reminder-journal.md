## What

there was an earlier session where we looked into weird anthropic refusals and how to keep reasoning quality maintained, some finding about token labels and similar, may be worth figuring out and looking back into to increase quality as well.

Resuming a session, or waking a parked subagent, on a later day than its first message made Claude lose every earlier thinking block: omp resent that first message with today's date, so Anthropic dropped all thinking signed before it and the prompt cache stopped at the system prompt. With this PR each message keeps the date it was first sent with.

| Live check, Haiku 5.5 with thinking | `main` | this PR |
|---|---|---|
| Main session resumed the next day | 2 of 2 earlier thinking blocks dropped; cache read 29,984 (system + tools only) | 0 dropped; cache read 30,779 (whole history) |
| Subagent parked, then woken by an IRC message after midnight, same process | 2 of 2 dropped; cache read 27,470, 1,675 written | 0 dropped; cache read 29,016 |

> **Reminder context.** omp puts `Today: <date>; current working directory: …` on the first user message of each request instead of in the system prompt (#7404). `DateCwdReminderInjector` remembers which date each message was first sent with, so later requests resend the same bytes and a new date is appended, never written into history. That memory lived only in the injector object, and a resumed session, a revived subagent and a `/resume` switch each get a new injector, which dated the first message today.

Reading order: `session/date-cwd-reminder.ts` (`DateCwdReminderJournal`, `#newRootState`, `#restoredRootState`, the `record` calls in `#inject`), then `sdk.ts` (`createTransformProviderContext` hands the main loop a journal).

## Why

Anthropic binds each signed thinking block to the exact bytes before it, and omp asks for `drop_block`, so a changed first message silently drops all of them (`inputTransformations: prefix_binding_mismatch` on the reply). Over one week of my own sessions on 18.14.0, this caused 144 of the 406 requests that went out with thinking dropped; subagents parked overnight and woken by an IRC message were most of them.

Each placement is now recorded as a `date-cwd-reminder` custom entry (`{ conversation, turn, reminder, placement: "prefix" | "control" }`, keyed by the injector's existing turn keys and scoped to the conversation it was sent in), and an injector meeting a conversation it has no state for rebuilds that conversation's reminders from the entries on the branch. This is the contract proposed in #15364's review: a custom entry like `system-prompt-digest`, read back from the branch, so fork, branch switch, compaction and `/resume` see the right set. #15364 predates the injector rework in #17117 and no longer applies; this is a fresh implementation on the new injector.

- A compaction can renumber retained turns that share a key (two identical messages in one millisecond), so a conversation that starts after one journals the reminders it inherits under the keys they hold in it.
- A context hook that re-creates its first message on every request, under a new timestamp, stays one conversation: its first message is found again by a digest of its content.
- The branch is read only for a conversation the injector shares no turns with, so it is read once per resume or revival, not per request.

- Rejected: dating the first message from its own timestamp (#15364's first version). The transcript does not say where a later reminder went (a date change mid tool loop, a `cd`), so that cannot rebuild them.
- Advisors and the auto-learn capture keep unjournaled injectors, so they never write into the main transcript.
- A transcript written before this PR has no entries and keeps `main`'s behaviour.

Cost: one small custom entry per placement (the first message, then one per date or cwd change). If the turn keys ever change shape, old entries stop matching and those sessions fall back to `main`'s behaviour; the reminder tests pin the keys.

Non-goal: the system prompt or tool list changing on resume.

## Testing

- `bun test test/date-cwd-reminder.test.ts` (in `packages/coding-agent`): 38 pass. 5 of the 6 new tests fail on `main`; the sixth guards the journal itself and fails against a journal that records turns under their original keys:
  - a fresh injector with the same journal, days later, resends an earlier injector's messages byte-for-byte, including a developer reminder placed mid tool loop, and puts the new date on the new message;
  - each placement is recorded once;
  - after a compaction renumbered a retained message, or a developer reminder's anchor, a fresh injector resends the compacted request unchanged (the anchor case is the sixth);
  - a first message a context hook re-creates on every request keeps its date across a fresh injector, and the journal is read once over six requests;
  - a file-backed `AgentSession` sends a message on Aug 14, is disposed and reopened from its file on Aug 16: the second request starts with the first request's messages unchanged.
- Live, real Anthropic, Haiku 5.5 (same prefix binding and binding controls as Opus 5.5 in `classes/anthropic.kdl`), request bodies dumped before sending: the two table rows. Next day for the resumed session: process one under `TZ=Pacific/Kiritimati`, resumed under `TZ=America/New_York`. After midnight for the subagent: `new Date()` shifted one day once it had parked.
- Full `packages/coding-agent` suite: 20415 pass, 8 fail; the same 8 fail or flake on `main`.
- `bun run check:types`, `oxlint`, `oxfmt` clean.

Closes #15343

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
