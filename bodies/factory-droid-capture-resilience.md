## What

When one case of the Factory Droid capture failed, the script threw away every case it had already paid for, so I made it write what it captured and name the reruns, and gave the primed case a prompt that reliably produces thinking.

`packages/ai/scripts/capture-factory-droid-native.ts` records droid's requests for `factory-droid-native-parity.test.ts`:

- A failed case keeps its entry from the existing fixture; captured cases are written, then the script exits 1 naming the reruns (`rerun with --only claude-opus-4-8`). A run that captured nothing leaves the file untouched. Full and `--only` runs merge through one helper, `mergeNativeCaptures`; `--only` with no fixture yet now writes the selected cases instead of stopping.
- An error thrown inside one case (droid printing non-JSON) fails that case, not the run.
- The `off after high` case's priming turn asks for a small calculation before the Read tool call (`prompts/factory-droid-capture-prime.md`). With the plain read prompt Opus 4.8 at `high` answered without thinking, leaving no thinking-led history to record.

| | `main` | this PR |
|---|---|---|
| Full run where 1 case fails | fixture not written, all captures lost | captured cases written, failed case keeps its old entry, exit 1 naming `--only <model>` |
| Opus 4.8 `off after high` priming turn with thinking | 0 of 5 | 3 of 3 |

## Why

Every case spends Factory credits. The last two full recaptures each lost all completed cases to this one failure and needed another full run.

The priming prompt never reaches the fixture: a primed case records only the resumed request, and `projectNativeRequest` drops `messages`, `system` and the other conversation keys. I left out a retry for the no-thinking case: the new prompt worked every time, and `--only` is the recovery.

Only a development script and its test helper change, so there is no CHANGELOG entry.

## Testing

The `mergeNativeCaptures` test: a recaptured case replaces its entry, a case differing from it only by `prime` keeps its old one, an undeclared entry drops out. It fails when the merge ignores the previous corpus, as `main`'s full run did.

Live with droid 1.7.1 (the pin) from an isolated login, `--droid` pointed at a wrapper that fails chosen cases and passes the rest to the real binary, each run starting from `main`'s fixture with chosen entries' `x-client-version` set to `stale`:

- **Full run**: `gpt-6-luna-fast` ran normally, the primed Opus 4.8 turn got non-JSON appended to its output, every other case failed. Luna was recaptured (`1.7.1`), the Opus case failed on the parse and kept `stale`, as did Haiku, every other byte matched `main`, exit 1 listing 59 cases.
- **`--only gpt-6-luna-fast --only claude-haiku-5-5`**, Haiku failing: Luna recaptured, Haiku kept `stale`, exit 1 with `rerun with --only claude-haiku-5-5`. With only Haiku selected, the file stayed byte-identical.
- **Priming prompt**: `claude-opus-4-8@anthropic off after high` captured 3 times; all 3 priming turns replayed thinking, and the fixture came out byte-identical to `main` each time.
- `bun test packages/ai/test/factory-droid-native-parity.test.ts`: 62 pass.

---

- [x] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
