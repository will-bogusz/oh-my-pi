## What

An agent installed a skill mid-session and then `read skill://<name>` said "Unknown skill" and `omp read skill://<name>` from bash died with exit 126, even though the skill was right there on disk, so I made a `skill://` name the session doesn't know rescan its skills once before giving up.

Run live on goliath (`omp -p`, Haiku): the agent creates `.omp/skills/live-check/SKILL.md`, then reads it.

| Second call | `main` | This PR |
|---|---|---|
| `read skill://live-check` | `Unknown skill: live-check` | the skill body |
| bash `/usr/bin/head -n 6 skill://live-check/SKILL.md` | `cannot resolve skill://live-check/SKILL.md for an external command`, exit 126 | the skill body, exit 0 |
| a typo'd name read in a loop | no rescan | one rescan per 2 s, then `Unknown skill` as before |

The main session already rediscovers when a known skill goes stale (#17027), but an unknown name threw against the startup list. `findUrlSkillAnew` (`internal-urls/skill-protocol.ts`) now checks the session's current list, then asks the session to rediscover (`SkillRediscoveryHost.rediscoverForUnknownName`). Every `skill://` consumer goes through `locateSkillTarget`, so `read`, bash arguments, `cd` and `%load` all get it.

Takes over #15253 (by iacore, co-author), which conflicts with `main` since #17027; this builds on #17027's per-session host and shared pass, which also settles that PR's review (no process-global refresher, concurrent misses share one pass).

## Why

Agents install skills mid-task (`omp skill install`, a plugin, `.omp/skills/`) and reach for them by URL; on `main` only `/reload` or a restart helped.

- **Rate limit, not a per-name memo.** At most one unknown-name pass every 2 s, joining one in flight, so a bash loop over a typo costs one pass per interval, while a skill installed right after a miss is still found once it passes.
- **Adopt only new skills.** If discovery returns nothing the list lacks, the list, prompt and rules stay as they were; a typo or an MCP-served URI (Figma's) then falls through to MCP as on `main`. A found skill joins the list and system prompt, as `/reload` does.
- **Only the owner republishes** the process-wide list (completions, authored-name checks), so a hit in one SDK/ACP session leaves another's alone.
- **Only the main session gains skills**: a subagent's list stays fixed at spawn.

Non-goal: a namespaced collision alias added after start (`skill://calendar/calendar` beside a bare `calendar`) still reads as a missing file inside `calendar`; telling it apart would put every missing-file read on the rescan path, which `main` pins to none. An alias already in the current list now wins over a stale copy.

## Testing

`test/skill-url-plugin-upgrade.test.ts`, real sessions and the `read` tool:
- `a skill created after the session started is readable and joins the session's list`
- `a skill found for one session leaves another session's process-wide skills published`
- `a name no skill owns rediscovers at most once per interval`: 3 misses, 1 pass, list kept; a skill created then is unknown at +1,999 ms and found at +2,000 ms (`setSystemTime`).

Reverting `src/` fails all three; publishing for any main session fails the second; adopting every pass fails the third. Branch: 27/27, plus 532 tests across the skill, internal-URL, bash-URL and rules/context reload suites; `bun run check` clean.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution
