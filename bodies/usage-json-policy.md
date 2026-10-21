## What

I have a script on my broker host that spends an account's saved reset once the account reaches its reserve, and since `omp usage --json` didn't say where the reserve was, the script had to re-implement omp's account-policy matching; this puts the policy line from the text view into the JSON.

For providers with `auth.accountPolicies`, every entry in `reports[]` and every OAuth entry in `accountsWithoutUsage[]` now has a `policy` object with the values the text view prints:

```json
"policy": { "priority": 10, "reservePct": 2, "reserveSource": "override", "state": "eligible", "remainingPct": 9 }
```

| Field | Value |
|---|---|
| `priority`, `reservePct` | the account's policy; the reserve falls back to `retry.usageReservePct` |
| `reserveSource` | `override` (set on the account) or `global` |
| `reclaimAbovePct` | present only when the policy sets it |
| `state` | `eligible`, `inside-reserve`, `exhausted` or `unknown`, read from the most-consumed window as the text line does |
| `remainingPct` | what is left in that window, rounded as the text line prints it; absent when nothing was measured |

Providers without an account policy and API-key accounts get no `policy` field, as in the text view. The text output is unchanged: the policy line now renders from the same `computePolicyDiagnostics` result that goes into the JSON.

## Why

The policy line is the one place `omp usage` says whether an account is inside its reserve. Without it in the JSON, a script parses that display string or rebuilds the policy lookup, and a rebuilt lookup goes stale whenever the line changes (`exhausted` and `reclaimAbovePct` were both added after this PR's first version).

This carries #13177 (schickling-assistant, co-author on the commit) forward. That PR was ranked P1 but no longer merges onto `main`, which has since added the `exhausted` state (#14764) and `reclaimAbovePct` (#14237) to the line. This version adds both and keeps #13177's shape: one computation for both outputs, with the policy matched before `--redact` masks identities. `remainingPct` uses the text line's `toFixed(1)` rounding, so JSON carries `9` rather than `8.999999999999996` and the two outputs never disagree.

Reading order: `UsagePolicyDiagnostics` → `computePolicyDiagnostics` → `formatPolicyLine` → `annotateUsagePolicy` and its call in the `--json` branch of `runUsageCommand`.

## Testing

- `bun test packages/coding-agent/test/usage-cli.test.ts`: 110 pass. The existing policy-line tests pass unchanged, so the text output didn't move. New cases:
  - JSON and text agree for eligible, inside-reserve (global reserve) and unknown accounts, with no `policy` on a provider without policies or on an API-key account.
  - A provider-exhausted account with `reclaimAbovePct` gives `state: "exhausted"` and the text `… · reclaim above 40% · exhausted · 0.5% left`.
  - At a binary rounding boundary (0.0195 used), JSON gives 98 and text `98.0% left`. Rounding with `Math.round(x * 1000) / 10` instead fails it.
  - `runUsageCommand({ json: true })` against fake Claude usage, with and without `--redact`: an override account and a global-reserve account get their own policies, the redacted output carries no email, and a Codex account without policies has no `policy` field. Serializing the reports without the annotation fails both runs.
- Live, against my auth broker: `omp usage --json --provider anthropic` from the branch gave three Claude accounts `eligible` 9, `inside-reserve` 77 (a 100% reserve) and `inside-reserve` 2, and `omp usage --provider anthropic` showed the same states and percentages.
- `bun run check:types` in `packages/coding-agent`, plus `oxlint` and `oxfmt --check` on the changed files. Not run: the repo-wide `bun check`, whose Rust half this doesn't touch.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
