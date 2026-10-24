## What

I added a wait option so opening a document and reading its new window can stay in one computer call.

On four window-opening tasks in one measured leg, relative model turns went from 1.00 → 0.82 with waiting enabled.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/4347020e-a220-41df-8b48-147d7f04d73c">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/20c90b53-8d2a-494a-9576-a2af4cff9a47">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/d748a753-3c53-424a-980f-83f1dc00e182">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/54592c20-ef35-46c7-848c-dfa0436b3912">
  <img width="780" alt="One leg: waiting for new windows used 0.82 times the control model turns on four window-opening tasks, with 95% interval 0.70 to 0.96. Unchanged-build four-task subset point estimates ranged from 0.84 to 1.05, so the target point estimate is just outside that spread, not its uncertainty." src="https://github.com/user-attachments/assets/20c90b53-8d2a-494a-9576-a2af4cff9a47" />
</picture>

`computer.window({app, title, wait: 3000})` polls for a matching window for up to the requested milliseconds, capped at 10 seconds. Primitive IDs and filters without `wait` still make one lookup; misses and ambiguous matches keep their existing errors. Waiting is read-only and cancellation-aware, including through Python keyword filters.

## Why

After a Finder double-click or an Activity Monitor inspector action, the new window may not exist yet. Immediate lookup fails, costing a separate model turn to list or resolve it.

**Maintainer call:** I chose an option on the existing resolver rather than a separate `waitForWindow(filter, ms)` helper so the one-window matching contract has one entry point. The 10-second cap bounds a mistaken filter; it is a policy choice, not a measured optimum.

No default wait, app launching, or wait-for-content behavior is added. Maintenance cost is a bounded 100-ms native-list poll, not a new OS watcher; ordinary listing failures still propagate.

## Testing

- `bun test packages/coding-agent/test/tools/computer.test.ts`: 130 pass. The 10 new cases exercise delayed arrival, read-only lookup, Python keywords, immediate misses/IDs, timeout diagnostics, cancellation and invalid waits; on main, 8 fail and the 2 immediate-lookup controls pass.
- `bun run check:ts` passes (two existing warnings).
- Haiku 5.5 low and GPT-6.1 Sol medium: two headless samples per task, per version, per family against a fake native desktop. All 16 transcripts passed (open a delayed PDF and read its code; read an existing document without input). Both families used `wait` in both new-window samples, never for the existing window. This is an adoption smoke check, not a speed estimate.

<details>
<summary>Measured leg, uncertainty and task medians</summary>

GPT-6.1 Sol medium ran macOS 26.5 VMs cloned from one frozen seed, control and variant in the same leg, 3 runs per arm per task, ABBA order. A turn is a model round trip with tool calls. Effects are geometric means over per-task median variant/control ratios, with bootstrap 95% intervals. This is one leg, not a replicated performance claim; all runs passed in both arms.

| Cohort | Turns | Wall time |
|---|---|---|
| Four window-opening tasks | 0.82× [0.70–0.96] | 0.81× [0.62–1.03] |
| All eight tasks | 0.87× [0.80–0.98] | 0.90× [0.76–1.00] |
| Unchanged build, seven tasks | 0.95× [0.85–1.10] | Not measured here |

Random four-task subsets of that unchanged-build comparison ranged 0.84–1.05×. The target-row point gain is just outside that spread, and its interval overlaps it. `wait` was used 34 times across 24 variant runs.

| Task | Median turns, control → variant | Median wall seconds, control → variant |
|---|---|---|
| Filled contact form PDF | 25 → 20 | 105 → 90 |
| Invoice PDFs | 31 → 26 | 126 → 91 |
| Preview from Finder | 19 → 15 | 89 → 62 |
| Activity Monitor inspector | 6 → 5 | 20 → 20 |
| Font Book | 10 → 8 | Not supplied |
| Lifecycle | 12 → 11 | Not supplied |
| Contacts | 8 → 8 | Not supplied |
| Reminders | 6 → 6 | Not supplied |

The all-eight-task wall ratio is the supplied aggregate from that full run set; only four per-task wall medians were supplied, so that aggregate cannot be reconstructed from this table.

The measurement used an integration build with just this change toggled, not a fresh origin/main benchmark. The port preserves the measured polling behavior. The public executable verification is the unit-test command above; the VM benchmark has no public rerun command.

</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
