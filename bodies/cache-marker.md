## What

I wanted to see before I send whether the next message is going to bust the cache, since when it's cold I almost always want to compact first, and that call should stay mine, not omp's.

On `main` the prompt cache only shows up after a turn (the footer's cache read and write counts); with this PR a `cache` status-line segment says before you send whether the next message reads the cache or re-sends the conversation uncached.

<img width="1005" alt="Tern composer in dark theme: a 'cached' chip with its hover card (expires 2:44 PM, 5m tier, next refresh 2:43 PM, reads ~32K from cache), and a 'not cached' chip on a reopened session (expired Oct 17 at 8:12 PM, 1h tier, re-sends ~323K, /compact snapcompact hint)" src="https://github.com/user-attachments/assets/20dba823-f2fc-4d6f-9ece-f9fe4a945e39" />

| Where | `main` | This PR |
|---|---|---|
| Status line, Tern composer (before the cost) | nothing about the cache before sending | `● cached` (muted) or `○ not cached` (warning); hidden when omp can't tell |
| Tern hover card, `/session` → Prompt Cache | — | why it isn't cached (expired, model changed A → B, thinking level, tools, system prompt, compaction, rewind or branch), when it expires and its tier, whether omp's cache warmer is refreshing it, tokens read vs re-sent ("up to" when the tools and system prompt may still be cached), and the `/compact snapcompact` hint |
| Reopened session | — | read off the newest reply that used the cache; "Likely cached" when it can only infer |

**Beyond the segment:** the `full` and `nerd` presets list it before `cost`; every other preset is unchanged. A `model_usage` record of a cache-warm refresh now keeps its send time (`sentAt`).

<details><summary>Classic TUI (<code>omp gallery --tool prompt_cache</code>, Nerd Font dots shown as ●/○)</summary>

```
 Sonnet 4.5 · high                                                    ● cached · $0.42 ★ 2 + 0.08
  State: Cached
  Expires: 2:10 PM (in 3 min)
  Tier: 5m
  Warming: next refresh 2:09 PM, gives up by 2:35 PM
  Next message: reads ~316K from cache, sends ~4.2K new

 Sonnet 4.5 · high                                                ○ not cached · $0.42 ★ 2 + 0.08
  State: Not cached
  Why not cached: model changed: Claude Opus 4.5 → Claude Sonnet 4.5
  Tier: 5m
  Next message: re-sends ~320K uncached
  Hint: /compact snapcompact first to send less
```

</details>

## Why

Closes #12677.

> **Prompt cache context.** A provider keeps the prompt prefix for a fixed lifetime after the last request that touched it (5 minutes or 1 hour on Anthropic, never on logged-in Codex). Past that, or on another model or tool set, the next request writes the whole prefix again; a changed thinking level, system prompt or history keeps the cached blocks ahead of the change.

- **One comparison.** The cache warmer already decides when its entry stops matching the next request; `start` now takes a `change()` that names what differs instead of an `isCurrent()` boolean, so there is no second shape check.
- **Two words on the bar.** The chip changes only when the answer does, through one timer at the expiry instant; details live on hover and in `/session`.
- **Expiry wins once the lifetime has passed**: it is certain. A change is named only while the entry would otherwise still be live.
- **Reopened sessions** read the newest cached reply, later refreshes that hit, compactions and the prompt digest recorded before that reply. Thinking level, tools and credential then are unknown, hence "likely".
- **Display only**: it never compacts or changes a request.

Non-goals: a credential rotation is not detected (omp cannot know which credential the next request uses), and a provider-side rewrite with nothing changed on our side cannot be predicted.

## Testing

| Test | Covers |
|---|---|
| `coding-agent/test/session/prompt-cache-status.test.ts` (real `AgentSession` + `CacheWarmer`, fake timers) | cached until the lifetime ends, not cached at that instant; a refresh hit moves the expiry and persists its send time, a miss turns it cold; model and thinking changes named; hidden without a lifetime; Codex still cached after 24 h; the confirming request's size kept after a failed one; another session's entry never shown; reopened: inferred from its reply, its own size, refresh from send time, its own prompt digest, compaction, expiry over a prompt change; 1,000 branch entries read once across ten reads, one more after an append |
| `coding-agent/test/event-controller-cache-warming.test.ts` | a refresh's start and end each repaint the status line |
| `tui/test/status-line-native.test.ts` | chip text, tone, tooltip and "up to", hover card rows, hidden cases, one repaint at expiry, dates on times outside today |

Against the source before the review fixes, the new session and event tests fail 8 of 17 and the "up to" test fails. `bun test` of the touched and related files: 1,876 pass in `coding-agent`, 929 pass (5 skipped) in `tui`. The image is a headless Tern render (`tern shot --theme dark`) of this branch on Haiku 5.5: a fresh session, and a reopened one whose last reply was 12 days old.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
