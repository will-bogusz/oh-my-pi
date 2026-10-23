## What

I put the computer guide in front of the model so desktop tasks can start without a separate documentation read.

Across seven native desktop tasks, model turns went from a normalized 1.00 to 0.81 with inline documentation.

The eval description includes the enabled computer guide rather than a read-first link. Other preludes remain linked; `xd://eval/computer` remains readable. No desktop API or approval behavior changes.

## Why

Every control run spent its first turn reading the guide. Supplying it before the first call removes that round trip without making the model guess the API.

**Maintainer decision: inline now or append after the first computer call.** I recommend inline: the measured gain clears control-to-control noise. It adds about 15.3 KB (3.6k tokens on Sol, 5.8k on Haiku) to every computer-enabled session's cached prefix, even without desktop use; computer use remains opt-in. Appending the guide to the first computer-call result, as Codex does, costs nothing for unused sessions but leaves that first call blind.

Related: #13688 explored first-call delivery; this takes the inline alternative. Broader descriptor compaction (#12462) is not part of this change.

Review `getEvalToolDescription` in `packages/coding-agent/src/tools/eval.ts` first, then the template in `src/prompts/tools/eval.md` and `createComputerPrelude`. The guide has one source, so edits flow into both delivery paths. Mid-session enabling still announces the existing link because the advertised description is a frozen snapshot.

## Testing

GPT-6.1 Sol medium, macOS 26.5 VMs from one frozen seed, ABBA order on one leg: six control runs and three inline runs per task; all passed. Ratios below are geometric means of per-task median ratios.

| Metric | Control | Inline |
|---|---:|---:|
| Model turns with tool calls | 1.00 | 0.81 |
| Wall time | 1.00 | 0.87 |
| Input tokens | 1.00 | 0.83 |

The initial guide read went from one per control run to none per inline run.

`bun run check:ts` passed; 137 focused tests passed. The new SDK regression fails without the computer opt-in and passes when restored. Full `bun check` was not run: there is no Rust change.

First-turn transcript samples on Haiku 5.5 and GPT-6.1 Sol medium (three tasks each): linked guides prompted six doc-read attempts; inline guides prompted six well-formed computer calls. These isolated calls used a synthetic system prompt, not the separate computer safety guidance; no calls were executed. One Haiku response requested an unnecessary `raise()`, so this measures routing, not safety compliance.

<details>
<summary>Uncertainty, noise control, and task medians</summary>

Re-run the contract checks:

```sh
bun test packages/coding-agent/test/tools/eval-description.test.ts packages/coding-agent/test/tools/computer.test.ts packages/coding-agent/test/sdk-computer-prelude-toggle.test.ts
bun run check:ts
```

The actual guide renders once with or without `read`, and its topic remains readable. The generic inline test fails without the rendering change; the SDK test fails without `inlineDocumentation: true`.

Bootstrap 95% intervals: turns 0.74–0.94; wall 0.78–0.97; input tokens 0.74–1.00. The two control slots ran the same build, three runs each: slot B / A was 0.95 (0.85–1.10) for turns and 0.96 (0.88–1.24) for wall time.

| Task | Turns control → inline | Wall seconds control → inline |
|---|---:|---:|
| Notes → Reminders | 9.5 → 10 | 36.5 → 41.5 |
| Contacts | 12 → 9 | 34.8 → 30.8 |
| Finder sort | 17 → 15 | 76.3 → 68.7 |
| Font Book | 12 → 8 | 53.2 → 34.0 |
| Preview | 20 → 18 | 66.2 → 62.0 |
| Reminders | 10 → 8 | 30.5 → 28.1 |
| Activity Monitor | 7.5 → 5 | 25.1 → 18.5 |

The benchmark exercised the implementation ported here, not a new desktop run during PR preparation.
</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
