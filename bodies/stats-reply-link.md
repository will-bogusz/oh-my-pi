## What

The Frustration page's per-model table was missing about half my messages, because replies now land behind a system-prompt digest entry instead of directly under the message, so this links each message to the first reply below it on its branch.

On 59 real transcripts from the last week, messages with no responding model drop from 176 of 1,349 to 11, and the per-model rows now add up to the overall count minus those 11 unanswered ones.

| | `main` | this PR |
|---|---|---|
| User messages with no model | 176 / 1,349 | 11 / 1,349 |
| Sum of per-model rows | 1,173 | 1,338 |

## Why

`omp stats` credited a user message to a model only when the reply's `parentId` was that message. Since the agent started writing a `system-prompt-digest` entry before each reply, the reply's parent is the digest, so the message dropped out of the per-model table while still counting in the overall one. Extension notices (`custom_message`), side-model `model_usage`, `credential_pin`, `title_change` and `mode_change` entries do the same.

The parser now links a user message to the first assistant message descending from it through non-message entries. A `/clear`, an invoked skill or a collab prompt below the message starts a new request, so the walk stops there.

Decisions:
- **Follow the tree, not file order.** Tracking only "the latest user message" mislinks on branches: an agent steer written as a sibling would take the slot, and a reply can follow an unrelated branch in the file. The parser keeps each waiting message with the non-message entries below it and drops them once it is answered; a tool result or bash message on a sibling branch does not close it.
- **Cursor state.** That map is saved in the parser cursor (`pendingReplies`), so a reply read in a later sync pass still links. A cursor from an older build has no map and is rebuilt from the transcript prefix once, the existing path for cursorless offsets. It held at most 17 ids per file above.
- **Re-link only what needs it.** `user_message_links_v2` drops the cursors of sessions holding an unlinked message, so one sync re-parses just those.

Reading order: `ReplyTracker` and `startsNewRequest` in `packages/stats/src/parser.ts`, their use in `parseSessionFile`, then `repairUserMessageLinks` in `packages/stats/src/db.ts`.

## Testing

- Live: a stats DB written by `main` over 59 real transcripts (isolated config), then opened with this branch: 176 unlinked messages before, 11 after one sync, the same as a fresh sync. A separate walk of the transcripts finds no assistant reply below any of the 11.
- `packages/stats/test/reply-links.test.ts` covers a reply behind a notice and digest, sibling branches, a skill and a `/clear` below a message, a reply read in a later sync pass (with a current and an older cursor), and the one-time re-link. All three tests fail with the `src` changes reverted.
- `bun run check` and `bun test` in `packages/stats` pass, except `db-cost.test.ts` "refreshes a historically zero-cost multi-agent row with orchestration usage on re-ingest", which fails the same way on `main`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
