## What

My Claude account showed up as exhausted in `omp usage` with 0% left because its Fable weekly was spent, while Opus and Sonnet were still routing to it fine, so this judges the policy state by the shared windows and names the spent model row next to it.

| `omp usage` on a Claude account at 7 Day 98%, 7 Day (Fable) 100%, reserve 2% | main | this PR |
|---|---|---|
| text policy line | `· exhausted · 0.0% left` | `· inside reserve · 2.0% left · Claude 7 Day (Fable) exhausted` |
| `--json` `policy` | `"state": "exhausted", "remainingPct": 0` | `"state": "inside-reserve", "remainingPct": 2, "scopedExhausted": ["anthropic:7d:fable"]` |

`scopedExhausted` is new and optional (present only when some row outside the shared windows is spent), so existing `--json` readers keep working; the ids match `limits[].id` in the same report.

## Why

Routing already treats these rows separately: a request with no model, or an Opus or Sonnet one, is gated only by the rows marked `scope.shared` (`scopeClaudeLimitsForModelHardBlock` in `packages/ai/src/usage/claude.ts`), and the Fable/Mythos weekly row gates only those families. `computePolicyDiagnostics` in `packages/coding-agent/src/cli/usage-cli.ts` took the max over every row, so the diagnostics said an account was out when routing would still pick it.

Decisions:
- The account-wide windows are the rows with `scope.shared === true` and no `sharedGroup`. Antigravity's `sharedGroup` rows are one subpool's quota beside unmarked Gemini counters, so Antigravity, like providers that mark nothing shared (Copilot, Devin), keeps main's every-row state. Asking each provider's `scopeLimits` for a model-less request was rejected: Antigravity and Cursor return no rows without a model, which would turn their state into `unknown`.
- Rows that are shared but per-meter, like Codex Spark, still count exactly as on main.

**Beyond the Fable case:** other non-shared rows beside account-wide windows (Claude Opus/Sonnet weeklies and Extra Usage, MiniMax model buckets, Z.ai's zread feature limit) also stop deciding `state`, and are listed in `scopedExhausted` when spent. Routing does not gate a model-less request on them either.

## Testing

- New case in `packages/coding-agent/test/usage-cli.test.ts` (*keeps the shared pool's state when only a model-scoped weekly row is spent*, with a spent Fable row and a 99.5% Opus row) asserts the JSON policy and the text line; with `usage-cli.ts` reverted to main it fails (`state: "exhausted"`, `remainingPct: 0`). A second case pins Antigravity's subpool rows to main's state. `bun test packages/coding-agent/test/usage-cli.test.ts -t policy`
- Live: `omp usage -p anthropic --json` from the branch and from main on two real Claude accounts. The one at 7 Day 98% / Fable 100% went from `exhausted, 0` to `inside-reserve, 2` with `scopedExhausted: ["anthropic:7d:fable"]`; the other account (Fable 0%) printed the same policy on both.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
