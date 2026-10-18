## What

I kept getting `ts-set-map` and `ts-import-type` reminders on code those rules explicitly say is fine, so this narrows their conditions (and `ts-no-any`'s) to what each rule's body actually flags.

Across my local sessions, of 1,052 firings of these three built-in rules whose tool-call arguments I could replay, 833 (79%) were on code the rule allows, and each one adds the rule's body to context.

| Rule | Fired on (`main`) | Now fires only on | Replayed false hits silenced |
|---|---|---|---|
| `ts-set-map` | every `new Set`/`new Map`, including `new Set<string>()` and `new Map(items.map(…))`, which its body says to keep | a string-literal array initializer: `new Set(["a", "b"])`, `new Map<K, V>([["k", v]])` | 585 of 640 |
| `ts-import-type` | every `import(`, so each `await import()` also raised it next to `ts-no-dynamic-import` | a type position: `import("pkg").Name`, `typeof import("pkg")` | 220 of 240 |
| `ts-no-any` | `: any` / `as any` anywhere, including "intact: anything", "has any one attached", `{ date: any.newest }` | `any` followed by a type-position token (`;` `,` `)` `[` `>` `\|` `=` `{`, newline, `as`, `satisfies`) | 28 of 172 |

Non-goals: rule bodies, scopes and every other built-in rule are unchanged.

## Why

Each condition was broader than the rule it guards, and these three fire on almost every TypeScript edit.

Decisions:
- **No match at a paused stream's edge.** TTSR checks a tool call's arguments while they stream, and a mid-stream match is recorded at once, so a condition that accepts the end of the buffer fires early: `intact: any` paused before `thing` would match. `ts-no-any` needs the character after `any`, and `ts-import-type` the whole member name after `import("x").`, so a runtime `.then`/`.catch`/`.finally` stays silent. The cost: `any` or `import("x").Name` as the very last characters of a tool call, with no `;` or newline after, no longer fires. Catching that needs a final-check-only match path in `TtsrManager`, which this PR does not add.
- **`ts-set-map` keys on a quote.** The body targets small static string-keyed tables; `new Set([sentence])` or `new Set([...a, ...b])` are dynamic. Enum-member literals (`new Set([Kind.A, Kind.B])`) no longer fire, since a regex can't tell them from variables. Type arguments may span lines or hold function types, but the match stops at the constructor's own `>`, so `new Map<K, V>().set(k, f<T>(["a"]))` stays silent.

## Testing

- `bun test test/discovery/builtin-defaults.test.ts` (15 pass): three new tests, one per rule, each a table of true positives that must fire and observed false positives that must not, plus a split-delta stream case for `ts-import-type` and `ts-no-any`. With the three `.md` changes reverted, all three fail on their first false-positive row.
- `omp ttsr test --rule <rule.md> --source tool --tool edit --path src/foo.ts '<snippet>'` with `main`'s and this branch's rule file: `const seen = new Set<string>();`, `await import("./x.js")` and `// mapping: any tool call wins` fire on `main` and not here; `new Set(["a", "b"])`, `type P = import("puppeteer-core").Page;` and `y as any;` fire on both.
- The counts above replay each recorded firing's tool-call arguments against both conditions. No `: any`/`as any` type use that fired on `main` is lost, and every silenced `ts-import-type` hit was a runtime `import()`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
