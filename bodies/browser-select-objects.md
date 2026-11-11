## What

I made browser `select()` accept explicit option selectors so a call like `select({label: "Monthly"})` picks the option instead of failing to match the object itself.

`tab.select(selector, ...choices)` and element-handle `select(...choices)` accept these forms on Chromium, cmux and Tern:

| Choice | Matches |
|---|---|
| `{label: "16 GB (+$200)"}` | Exact label or full option text with whitespace collapsed and trimmed |
| `{value: "16 GB"}` | Exact option value only |
| `{index: 0}` | Zero-based option position |

Strings retain value-first, then label matching; Tern and cmux also retain primitive-to-string coercion. Forms can mix in a multi-select call; invalid objects and unmatched options leave selection untouched. Both browser references now give the signature.

## Why

An agent can pass the visible label correctly but wrap it in `{label: ...}`, a familiar selection API shape. Previously that failed even inside an otherwise correctly resolved shadow-root or frame handle.

This adds the explicit forms rather than relying on a documentation warning. Validation is shared in `normalizeSelectOptions`; each backend retains its selection and event dispatch path. Post-handler selection readback is outside this change.

## Testing

- `bun test packages/coding-agent/test/tools/browser-interactions.test.ts -t selects`: the regression fails on main at object-label matching and passes with this change. Covers string precedence, explicit forms, mixed multi-select, invalid inputs without events, cmux's injected script and Tern's page kit, including their existing number/boolean coercion.
- No-model headless Chrome for Testing replay of the original country, memory and schedule calls, five repeats each: object-label selection goes from 0/15 to 15/15, with correct live-value readbacks through an open shadow root and the nested cross-origin frame chain. A same-origin frame control also passes 5/5.
- `bun run --cwd packages/coding-agent check` passes (existing lint warnings only).

No model sample was needed: the references describe the argument contract exercised directly against real page state.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with contributor credit; PR link is added when opened
