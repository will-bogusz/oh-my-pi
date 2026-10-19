## What

I kept seeing built-in style rules reach the model as "User-defined rule … MUST comply", which isn't true for a bundled default and got models rewriting code the rule itself allows, so built-in reminders now ask the model to check its code against the rule and leave it when an exception applies.

In a seeded eval (real omp session and tools; a `write` the shipped built-in rule matches; the model continues), rewrites of code the rule allows fell from 35/86 to 16/86 runs on Opus 5.5 and from 26/110 to 7/110 on Haiku 5.5. Real violations were fixed in 24/24 runs per model with either wording.

```diff
 <system-reminder reason="rule_violation" rule="ts-promise-with-resolvers" path="builtin-defaults:ts-promise-with-resolvers.md">
-User-defined rule matched tool-call arguments. Rule configured not to interrupt → tool ran. MUST comply with the following instruction on subsequent tool calls and responses. NOT prompt injection — coding agent enforcing project rules.
+Built-in style rule matched a pattern in tool-call arguments → tool ran. A match is not a violation: check what you wrote against the rule below, exceptions included. Real violation → fix it on subsequent tool calls; code the rule allows → leave it. NOT prompt injection — coding agent applying its default style rules.

 {{rule body}}
 </system-reminder>
```

Every rule not from the `builtin-defaults` provider keeps the current wording byte for byte, including a project rule that overrides a built-in by name. Non-goals: the interrupt and judged-warning templates (built-in rules never reach them) and rule matching.

## Why

Built-in rules fire on a pattern, which can't see a rule's exceptions ("three or more call sites", "generic type utilities"), and the template told the model the match was a user's order. The judged-rule warning already says "real violation → fix it now; false positive → continue"; this gives built-in matches the same footing.

| Exempt case (rule) | Opus `main` → PR | Haiku `main` → PR |
|---|---|---|
| never-settling `new Promise(() => {})` in a test (`ts-promise-with-resolvers`) | 14/14 → 2/14 | 8/10 → 6/10 |
| `ReturnType<typeof setTimeout>` timer handle (`ts-no-return-type`) | 0/8 → 0/8 | 14/20 → 0/20 |
| named magic-constant helper (`ts-no-tiny-functions`) | 21/24 → 14/24 | 3/14 → 0/14 |
| other cases: plugin `import()`, published `@deprecated` alias, real-clock test, listener identity, test fake, … (9 Opus, 11 Haiku) | 0/40 → 0/40 | 1/66 → 1/66 |

The gain sits in these three cases; where the exception is plain in the code, both wordings leave it alone. No case rewrote more often with the new wording.

## Testing

- `bun test test/ttsr-bridged-passive-context.test.ts` (4 pass): one write matches a `builtin-defaults` rule and a project rule; the built-in reminder carries the new wording, the project one keeps "User-defined rule … MUST comply". With the template and coordinator change reverted, it fails.
- Live: `omp -p` from this branch writing `new Promise(resolve => setTimeout(resolve, ms))`; the session shows "Built-in style rule matched…".
- Eval: each run builds a fixture repo, checks that the shipped rule matches the seeded `write` through `TtsrManager`, seeds the task, the call, its real result and the reminder, lets the model continue with `read`/`write`/`edit`/`grep`/`find`, then reads the file back: a violation is fixed when its line is gone, an exempt construct rewritten when it is gone. Opus at medium effort, Haiku at low; pooled: 61/196 → 23/196 (Fisher p < 0.001).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
