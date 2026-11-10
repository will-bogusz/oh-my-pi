## What

Every browser task on main opened by reading the whole browser guide, so I put a short core of it in the Eval description and left the full guide where it was.

On four browser tasks, an agent's tool calls went from 1.00 to HAIKU_STEPS of `main` on Claude Haiku 5.5 and to SOL_STEPS on GPT-6.1 Sol, and tokens per task to HAIKU_TOKENS and SOL_TOKENS.

| 4 browser tasks × 4 runs per arm | `main` | this PR |
|---|---|---|
| first call reads `xd://eval/browser` (Haiku / Sol) | HAIKU_READ_MAIN / SOL_READ_MAIN | HAIKU_READ_PR / SOL_READ_PR |
| tool calls per task (Haiku / Sol) | 1.00 / 1.00 | HAIKU_STEPS / SOL_STEPS |
| tokens per task (Haiku / Sol) | 1.00 / 1.00 | HAIKU_TOKENS / SOL_TOKENS |
| failed tool calls, all runs (Haiku / Sol) | HAIKU_ERR_MAIN / SOL_ERR_MAIN | HAIKU_ERR_PR / SOL_ERR_PR |
| tasks passed (Haiku / Sol) | HAIKU_PASS_MAIN / SOL_PASS_MAIN | HAIKU_PASS_PR / SOL_PASS_PR |

**Cost:** +1,530 tokens (Haiku; SOL_PREFIX on Sol) on the first request of every session with the browser enabled, which is the default, browsing or not; later requests read it from the prompt cache.

A prelude can now carry `coreDocumentation`: `getEvalToolDescription` renders it in place of the prelude's `xd://eval/<name>` line, under a header saying it is partial and where the full reference is, and `documentation` stays that topic. The browser prelude sets it to `prompts/tools/browser-core.md` (helpers with signatures, units, selector forms, `tab.run` is Node, the re-observe rule, the critical lines). `inlineDocumentation` still wins, and a session without `read` still gets every topic in full. Non-goals: the full guide's content, which only gains the signatures the core shows; the computer prelude.

## Why

On `main` the first call of nearly every browser run was a read of the 14 kB guide (5.5k Haiku tokens), which then sat in every later request.

- **Full guide inline, as the computer prelude does (PR 16918):** measured on Haiku, it removed the read and nothing else (tool calls 0.89×, interval spans 1.0) for +5.5k tokens per session. The core does better at a quarter of the cost.
- **Guide attached to the first browser call's output (PR 13688's route for computer):** rejected; the first call is written blind, and main has no per-cell hook for it.

**Maintainer decision: the always-on cost above.** I recommend taking it: on both models the saving per browser task is tens of thousands of tokens, against ~1.5k once per session. The alternative is an opt-in setting, which keeps `main`'s cost and loses the gain by default.

Maintenance: the core is a second text about the same API. `browser-prelude-documentation.test.ts` fails when the core names a helper, option or parameter the full guide no longer names, which catches renames; a changed meaning still needs both files edited.

## Testing

- Bench web tasks (arXiv form, CyberChef upload, pointer-only controls, cross-turn handoff), headless Chrome for Testing, `main` (e1d8f29d549) against this head, 4 runs per task and arm in alternating order, graded by each task's grader. Haiku 5.5 medium and GPT-6.1 Sol medium.
- Cost: a one-line arithmetic prompt with the browser enabled, Haiku first request 13,432 tokens on `main`, 14,962 here (identical over 2 runs each).
- `bun test test/tools/browser-prelude-documentation.test.ts test/tools/eval-description.test.ts`: 19 pass. With the `eval.ts` change reverted the core test fails; with an identifier dropped from the full guide the drift test lists it.

<details><summary>Ratios and intervals</summary>

DETAILS_TABLE

</details>

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
