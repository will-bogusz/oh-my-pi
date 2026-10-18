## What

Auto-QA reports about `xd://tui` kept landing under the tool name `xd` with `//tui: …` as the report, so I made a one-line report split at the `: ` the documented format uses instead of at its first colon.

`write xd://report_issue` takes `<tool>: <concise description>`. The parser cut a one-line report at the first `:` anywhere, so a tool name that is a URI or a call lost everything from its first colon on. In one local auto-QA database, 11 of 203 reports since Oct 1 were stored that way:

| Report the model wrote | Stored on `main` (tool / report) | Stored with this PR |
|---|---|---|
| `xd://tui: start fails because kitty-vt-wasm is missing` | `xd` / `//tui: start fails …` | `xd://tui` / `start fails …` |
| `write xd://tui: start fails before executing bun` | `write xd` / `//tui: start fails …` | `write xd://tui` / `start fails …` |
| `write conflict://*: per-id content "2:\ttext" was read as …` | `write conflict` / `//*: per-id …` | `write conflict://*` / `per-id …` |
| `read agent://X returned an empty response` | `read agent` / `//X returned …` | refused with the format hint |
| `browser.open({name:'jio-terms',url:…}) navigated …` | `browser.open({name` / `'jio-terms',url:…` | refused with the format hint |

**Beyond the split:** a one-line report with a colon but no `: ` (last two rows) now gets the `Invalid report format` usage hint that `main` already returns for a report with no colon at all, instead of being stored cut at that colon. In 358 `xd://report_issue` writes from my local session transcripts that was 4 reports (1.1%). Keeping them would mean storing the whole line under a placeholder tool name such as `unknown`; falling back to the first colon would bring this bug back.

## Why

The separator is the first colon followed by whitespace, which is what the system prompt and the device's usage text ask for. Skipping only `://` was the other candidate; it still cuts unspaced call arguments like `{name:'jio-terms'}`. Known limit, unchanged from `main`: a tool name holding a spaced argument (`browser.open({name: 'x'})`) still splits at that argument. A `read:foo: bar` shorthand, which the format does not allow and none of the 358 writes used, now splits at the second colon.

The two-line form (tool on line 1, report below) is unchanged. Non-goals: rows already stored, deduplication, scrubbing paths from reports.

## Testing

- `bun test packages/coding-agent/test/tools/report-tool-issue.test.ts`: 30 pass. New rows record the three URI shapes above and refuse the two colon-only shapes with `Invalid report format`. With the parser change reverted, those 5 fail (`xd` stored for `xd://tui`, and the two refusals resolve instead).
- LIVE_PLACEHOLDER

---

- [ ] `bun check` passes
- [ ] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
