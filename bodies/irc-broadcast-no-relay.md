## What

When one of my agents broadcast to `agent://all`, every idle agent it woke answered automatically, almost always to say the message wasn't for it, so I made broadcasts never draw that automatic answer.

One broadcast to 24 agents woke 15 of them and drew 14 automatic replies within 5 seconds; with this PR a broadcast draws none, and the sender hears only from agents that choose to `write` back or `yield`.

| Message an idle subagent wakes on | `main` | This PR |
|---|---|---|
| Direct message from a peer | turn's last text relayed back to the sender | same |
| Direct message from its parent | turn delivered to the parent as a background job result | same |
| `agent://all` broadcast from a peer | turn's last text relayed back to the broadcaster | nothing sent |
| `agent://all` broadcast from its parent | turn delivered to the parent as a background job result | nothing sent, unless the child yields (unchanged) |

Reading order: `executeSend` (`irc/messaging.ts`) marks each leg `broadcast: true` -> `IrcBridge.deliver` copies it into the `irc:incoming` record and stops promising a stop relay -> `wakeSources` (`task/executor.ts`) skips broadcast records.

## Why

`executeSend` expands `all` into one plain direct message per peer, so the recipient cannot tell a broadcast from a question addressed to it. An idle subagent's wake turn then treats the broadcaster as its waker: `relayWakeTurnOutput` sends its stop text back, or, when the broadcaster is its parent, the whole turn registers as a job the parent receives. The woken agent's card promised its last words to the sender, so most turns ended explaining why the message did not apply.

Decisions:
- The flag rides on `IrcMessage` next to `wakeRelay` (the relay ping-pong marker), so it reaches the persisted record the wake monitor reads, and `wakeSources` skips both.
- A `yield` during a broadcast-woken turn still reaches the parent: it is the child's own result, submitted on purpose, not a reply sent on its behalf.
- A batch holding both a broadcast and a direct message from the same sender still relays once, to the direct message.

Non-goals: whether a broadcast should wake idle agents, or reach only the sender's subtree; this PR changes only what comes back.

Maintenance: a new path that builds `irc:incoming` records must copy `broadcast`, as it already must copy `wakeRelay`.

## Testing

Live, `claude-haiku-5-5` for every role: the main agent spawns two task subagents, waits for both, broadcasts "FYI only: no reply needed." and waits 40 s. With `src/` reverted it received two automatic results, "Acknowledged, no reply needed." from each child; with this PR it received none, though both were `woken`.

`test/tools/irc.test.ts`, "wake-turn replies to broadcasts", drives idle subagents through the real `IrcBridge` and wake-turn monitor:
- a peer broadcasts: nothing comes back; a direct message then relays the turn once;
- `Main` broadcasts to its children: no message and no wake job; a direct message registers the job; a child that yields still delivers its yield;
- a wake batch mixing a broadcast and a direct message from one sender, in either order, relays once.

`test/session/irc-bridge-relay.test.ts` pins the record flag and the card text. With `src/` reverted, four fail; the yield test passes on both, as it should.

```
cd packages/coding-agent && bun test test/tools/irc.test.ts test/session/irc-bridge-relay.test.ts test/task/persisted-revive.test.ts
```

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
