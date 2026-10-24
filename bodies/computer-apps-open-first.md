## What

I changed the computer guidance to open the app and use the window it returns, rather than look for a window that might not exist yet.

Across eight macOS desktop tasks, model turns went from a normalized 1.00 → 0.82, with all 48 runs passing.

The starting example changes from `computer.window({ app: "Code" })` to `computer.apps.open("Code")` and its returned window. Review added platform scoping, null fallback and Python dictionary access. A subsequent behavioral check made the window property explicit in the system example. No desktop API or approval behavior changes.

## Why

Agents looked for a window, hit “no window matches”, opened the app, then looked up its window again. The existing app-opening helper already returns a usable handle on macOS, so there is no new helper to maintain.

Related: #16912 improves recovery after a window lookup fails; this avoids the unnecessary lookup.

**Risk:** an already-open macOS app returns its frontmost window; a specific-window task still needs `window({app, title})`. Opening a running app without a window can show one behind the user's app. Linux and Windows return null, so examples fall back to window lookup; the VM measurements make no claim about those platforms.

## Testing

GPT-6.1 Sol medium, macOS 26.5 VMs, one frozen seed: eight native/cross-app tasks, three runs per arm per task, ABBA order on the same leg. Control was the same build without the original prompt change. Ratios are geometric means of per-task median change/control ratios; intervals are bootstrap 95%.

| Metric | Ratio | Interval |
| --- | ---: | --- |
| Model turns | 0.82 | 0.75–0.93 |
| Wall time | 0.88 | 0.81–1.04 |
| Input tokens | 0.84 | 0.75–0.95 |

The turn gain clears the earlier unchanged-control spread; the wall gain is suggestive only. The VM harness is private, so these measurements are not publicly reproducible.

A stub-desktop harness, 798 runs, Haiku 5.5 and Sol, then exercised the real CLI with transcript scoring. Haiku misread the earlier wording as `app.window()`; the explicit property example reduced start-on-app runs containing an eval error from 27/36 → 1/36. Sol remained at 0/9 errors; this is simulated-desktop evidence, not another native-VM benchmark.

JS and Python facade/worker checks passed: `bun test packages/coding-agent/test/tools/computer.test.ts --test-name-pattern 'routes nested menus, displays, observation, applications and bounded holds through the JS facade and worker|routes Python nested handles and new methods through the actual kernel and worker'`. Full `bun check` was not run for this Markdown-only diff.

<details>
<summary>Benchmark and behavioral-check detail</summary>

The 48-run VM measurement used the original macOS candidate; platform and language clarifications were added after review, then the final system example was checked in the stub harness.

| Task | Median turns, control → change |
| --- | --- |
| Contacts to form to Finder | 24 → 24 |
| Notes to Calendar meeting follow-up | 19 → 16 |
| Notes to Reminders | 10 → 6 |
| Contacts edit | 10 → 8 |
| Finder sort | 17 → 15 |
| Preview rotate/export | 21 → 16 |
| Reminders move | 9 → 6 |
| Activity Monitor read | 6 → 7 |

Window-acquisition turns per run: 3.42 → 2.04. “No window matches” errors per run: 0.29 → 0.08. Earlier unchanged-control ratios: turns 0.95 (0.85–1.10), wall 0.96 (0.88–1.24).

The stub harness preregistered its tasks, metrics and per-round decisions. Its 798 sessions span main, this change, a related open/reveal change, their combination and wording prototypes, not 798 replications of this patch. Haiku ran at low effort, Sol at medium. Notes and Reminders had no window until opened; Chrome was already running. Scores came from tool transcripts and expected text read from stubbed windows; no host desktop was driven.

| Start-on-app metric | Main | Earlier wording | Final wording |
| --- | ---: | ---: | ---: |
| Haiku runs with an eval error | 11/18 | 27/36 | 1/36 |
| Haiku app-first | 3/18 | 29/36 | 35/36 |
| Haiku correct answer | 8/18 | 28/36 | 32/36 |
| Sol runs with an eval error | 0/9 | 0/9 | 0/9 |
| Sol app-first | 3/9 | 6/9 | 7/9 |
| Sol correct answer | 8/9 | 7/9 | 8/9 |

Haiku error-run reduction versus earlier wording: −72 percentage points (95% Newcombe −84 to −53). Sol's app-first difference versus main includes zero; no reliable Sol improvement is claimed. Final wording caused no misuse or failed app opens on the UI-only controls (Haiku 0/18, Sol 0/9), and no desktop side effects on the no-action controls (Haiku 0/12).

Earlier one-response samples with the guide preloaded scored returned-window-and-read selection at Haiku 0/3 → 3/3 and Sol 0/3 → 1/3. These did not execute generated calls and could not detect the runtime error found by the later stub harness; they are not task-success evidence.
</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (entry added; PR link and credit are added when the queue opens it)
