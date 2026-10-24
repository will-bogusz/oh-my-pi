## What

I changed the computer guidance to open the app and use the window it returns, rather than look for a window that might not exist yet.

Across eight macOS desktop tasks, model turns went from a normalized 1.00 → 0.82, with all 48 runs passing.

The starting example changes from `computer.window({ app: "Code" })` to `computer.apps.open("Code")` and its returned window. The measured candidate was the macOS guidance; review added explicit platform scoping, null fallback in both examples and Python dictionary access. No desktop API or approval behavior changes.

## Why

Agents looked for a window, hit “no window matches”, opened the app, then looked up its window again. The existing app-opening helper already returns a usable handle on macOS, so there is no new helper to maintain.

Related: #16912 improves recovery after a window lookup fails; this avoids the unnecessary lookup.

**Risk:** an already-open macOS app returns its frontmost window; a specific-window task still needs `window({app, title})`. Opening a running app without a window can show one behind the user's app. Linux and Windows return null, so examples fall back to window lookup; the macOS measurements make no claim about those platforms.

## Testing

GPT-6.1 Sol medium, macOS 26.5 VMs, one frozen seed: eight native/cross-app tasks, three runs per arm per task, ABBA order on the same leg. Control was the same build without this prompt change. Ratios are geometric means of per-task median change/control ratios; intervals are bootstrap 95%.

| Metric | Ratio | Interval |
| --- | ---: | --- |
| Model turns | 0.82 | 0.75–0.93 |
| Wall time | 0.88 | 0.81–1.04 |
| Input tokens | 0.84 | 0.75–0.95 |

The turn gain clears the earlier unchanged-control spread; the wall gain is suggestive only. The VM harness is private, so these end-to-end measurements are not publicly reproducible.

First-response samples ran on main and the final wording, with each arm's guide supplied and no tool executor: Haiku selected the returned window and read it in 0/3 → 3/3, Sol in 0/3 → 1/3. Haiku also switched Python → JavaScript; Sol requested control first for Reminders and Finder in both arms. These measure call selection, not completion; no desktop calls ran.

Existing JS and Python facade/worker checks passed (one each): `bun test packages/coding-agent/test/tools/computer.test.ts --test-name-pattern 'routes nested menus, displays, observation, applications and bounded holds through the JS facade and worker|routes Python nested handles and new methods through the actual kernel and worker'`. Full `bun check` was not run for this Markdown-only diff.

<details>
<summary>Benchmark detail and sample reproduction</summary>

Tasks: Reminders move, Contacts edit, Notes to Reminders, Finder sort, Preview rotate/export, Activity Monitor read, Notes to Calendar meeting follow-up, Contacts to form to Finder.

| Task | Median turns, control → change |
| --- | --- |
| Contact form | 24 → 24 |
| Meeting follow-up | 19 → 16 |
| Notes to Reminders | 10 → 6 |
| Contacts | 10 → 8 |
| Finder sort | 17 → 15 |
| Preview | 21 → 16 |
| Reminders | 9 → 6 |
| Activity Monitor | 6 → 7 |

Window-acquisition turns per run: 3.42 → 2.04. “No window matches” errors per run: 0.29 → 0.08.

Earlier unchanged-control ratios: turns 0.95 (0.85–1.10), wall 0.96 (0.88–1.24).

To repeat the isolated first-response check, use `completeSimple` with `ModelRegistry`/`discoverAuthStorage`, `reasoning: "medium"`, the unmodified eval schema, and each revision's `prompts/system/computer-use.md` plus `prompts/tools/computer.md` as system context. Request one response only, without executing tool calls. Run `anthropic/claude-haiku-5-5` and `openai-codex/gpt-6.1-sol` on these requests:

- Find the reminder named Book dentist and mark it complete in Reminders.
- Find Ada Lovelace in Contacts and read her phone number.
- Show Downloads in Finder and sort it by date modified.

Score whether the first call uses `apps.open`'s returned window and reads it in the same call. The unchanged prompt is the negative control. This isolates guide wording, not documentation delivery. Original candidate samples gave the same aggregate scores; final wording was sampled again after review fixes.
</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (entry added; PR link and credit are added when the queue opens it)
