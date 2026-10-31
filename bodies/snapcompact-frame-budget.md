## What

Anthropic documents 600 images per request, so I wanted to know why Opus archives stop at 80 frames; past that its API starts failing around 100 high-res frames, while gpt-6.1-sol kept reading better up to 107, so the frame cap is now set per host.

Snapcompact archives on the Codex backend can hold up to 107 frames instead of 80; the Anthropic API keeps 80, now a measured limit. With archives forced to each size, gpt-6.1-sol's recall went from 36% at 80 frames to 46% at 107, and no higher.

| Archive frames | Opus 5.5 (Anthropic API) | gpt-6.1-sol (Codex backend) |
|---|---|---|
| 40 | 35% | 25% |
| 80, main's cap | 62% | 36% |
| 107, this PR's Codex cap | – | 46% |
| 128, the most that fits gpt-6.1-sol's window | – | 46% |
| 100 to 160 high-res frames | API error on every request | – |

**Where it applies:** the archive is still sized by the room under the compaction trigger; the cap binds past that. At the default trigger a 1M-window Codex model (gpt-5.6-sol, -luna, -terra) now plans 107 frames instead of 80; gpt-6.1-sol's 500K window plans about 71.

**Beyond the cap:** an archive sent to a host with a smaller budget (107 Codex frames, then a switch to Claude) sends its newest frames that fit, and Claude's no-reasoning re-render stays within its budget. On `main` nothing exceeded 80, so neither cut anything.

## Why

`MAX_FRAMES_DEFAULT = 80` capped every host, citing a ~100-image request limit Anthropic has since raised to 600. Raising it there would break Anthropic:

> **Anthropic's ceiling.** `/v1/messages` on Opus 5.5 and Sonnet 5.5 answers `api_error: Unable to complete this request right now.` within about 2 s and bills nothing, while `count_tokens` accepts the same body. Opus 5.5 took 95 native 1932px frames and failed every request with 100 to 160. Real archives passed at 80 (13.7 MB) and failed at 120 (20.5 MB) and at 80 denser frames (18.6 MB).

- **gpt-6.1-sol** gained +0.10 [0.06, 0.14] from 80 to 107 frames and +0.01 [−0.02, 0.03] from 107 to 128; 107 is also what its 12 MB frame byte share holds. gpt-5.6 recall past 80 was not measured.
- **A KDL axis, not a bigger constant:** the limit differs per host. Hosts without the rule keep 80.
- **80 for Anthropic, not 95:** denser frames failed at 80.
- **Non-goals:** how much of the trigger the archive gets, other hosts, frame shapes, byte budgets.

Maintenance: two numbers in `anthropic.kdl` and `openai-codex.kdl`; if Anthropic lifts its ceiling, archives forced past 80 stop returning that `api_error`.

## Testing

- Live: five sessions with 6 to 20M chars of history, cut before a real compaction, resumed in omp's RPC mode with the archive forced to 40, 80, 107 or as many frames as fit, two runs each. The first prompt is a ~60-question quiz at known distances back, graded by exact match or an other-family judge; paired 95% bootstrap over sessions, then questions.
- coding-agent `bun test` of the snapcompact trigger-room, reader and provider-image-budget suites, and snapcompact `bun test`: gpt-5.6-sol at the default trigger plans 107 frames (80 on `main`), Opus 5.5 plans 80, a 107-frame archive sent to Claude keeps its newest 80, the no-reasoning re-render asks for 80, and `compact()` renders 85 frames when asked. Each fails on `main`'s sources.
- `bun check` passes.

<details><summary>Rig and build</summary>

Build: `main` at `6a86df8539f` with this change, frame counts forced per run. Anthropic failures came from the sweep's real archives and from requests carrying 20 to 160 rendered 1932px frames on Opus 5.5 over OAuth. First-turn time to first token grows with the archive: gpt-6.1-sol 14 s at 80 frames, 18 s at 107; Opus 13 s at 40, 26 s at 80.

</details>

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
