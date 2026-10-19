## What

I kept seeing agents send `[file#AUTO]` or a header-only edit, get an error with no tag in it, and spend a `read` just to copy one, while `#0000` already gets the tag back, so now every tagless shape gets that reply.

A placeholder tag (`#AUTO`, `#????`, a bare `#`), no tag, or a header with no ops now gets the unknown-tag reply: the current tag, plus anchored context when there are anchors. On Opus 5.5, a forced tagless first edit went from a `read` every time (0/18 skipped it) to a resend with the returned tag (16/18), calls to success 3.0 → 2.0-2.3.

| Input | `main` replies | This PR replies |
|---|---|---|
| `[a.py#AUTO]` + ops | `Input header must be [PATH] or [PATH#TAG] with a 4-hex content-hash tag; got "[a.py#AUTO]".` | `Edit rejected for a.py: the header needs this file's current tag, #CD30.` + the `#0000` advice line + anchored context |
| `[a.py]` + ops | `Missing hashline snapshot tag for a.py; use [a.py#tag] from your latest read/search output. …` | same as above |
| `[a.py#0000]` (header only) | `No hashline sections found in input.` | `Edit rejected for a.py: no ops follow the header; put them under this file's current tag, #CD30.` + advice line |
| `[a.py#0000]` + ops | unchanged: `hash #0000 is not from this session` + current tag + context | unchanged |

**Nothing new applies.** A section with a placeholder or no tag never writes, and a placeholder never borrows another same-path header's tag (a bare `[a.py]` repeated under a tagged `[a.py#TAG]` still merges into it, as on `main`). That includes `PUT <1:`/`PUT >$:`, MV and REM, which an unknown hex tag can still push through with a drift warning. A missing file gets the `write` pointer; a handler URL (`agent://`, `ssh://`) gets its own refusal, since the path now resolves before the tag check. The header error no longer lists `[PATH]` as valid.

Reading order: `input.rs` `recover_header` → `patcher.rs` `stage_patch`, `header_only_error` → `mod.rs` `stage` → `mismatch.rs`.

## Why

Agents that saw a file only through `bash` have no tag and fill in a stand-in. In 612 such failed calls in my sessions since 10-01 (all Opus 5.5), the reply decided what came next:

| Shape | n | next call resends with the returned tag | succeeded without a read | calls to success |
|---|---|---|---|---|
| `#0000` + ops | 320 | 84% | 87% | 1.43 |
| non-hex tag / no tag / header-only | 292 | 0% | 3-7% | 2.5-2.6 |

The wording matters: an earlier first line, "the header carries no 4-hex snapshot tag", still sent Haiku 5.5 to `read` on 5/8 `#AUTO` runs; "needs this file's current tag, #X" got 8/8 to resend.

Decisions: placeholders take the `#0000` path (same snapshot recording, so the same seen-line check on the resend), so this allows nothing a model can't already get by sending `#0000`. I didn't add the "read first, never invent a tag" prompt line: #16253 adds it to both hashline prompts.

Related: #16000.

## Testing

- Replay: 612 recorded failing inputs ran through the real `EditTool` against a synthetic file, with the addon built from `main` and from this branch. The current tag came back in 0/292 → 290/292 cases (the 2 misses are headers containing a newline). No writes in either arm.
- Live: fresh agent dir, first call forced to the tagless shape, then free; the file was checked for the exact change.

| Model (low effort), n per arm | First call | `main`: no read / calls | PR: no read / calls |
|---|---|---|---|
| Opus 5.5, 6 | `#AUTO` | 0/6, 3.0 | 6/6, 2.0 |
| Opus 5.5, 6 | no tag | 0/6, 3.0 | 6/6, 2.0 |
| Opus 5.5, 6 | header only | 0/6, 3.0 | 4/6, 2.33 |
| Haiku 5.5, 8 | `#AUTO` | 0/8, 3.0 | 8/8, 2.0 |

Every run in both arms ended with the correct file. Haiku still reads after no-tag and header-only (1/8 each); unforced, both models read first in both arms.
- `cargo test -p pi-edit` passes. With the `src` changes reverted, 10 tests fail (`untagged_sections_get_the_current_tag_like_an_unknown_one`, `header_only_input_gets_the_current_tag`, `placeholder_section_does_not_borrow_a_same_path_tag`, `untagged_head_and_tail_inserts_do_not_apply`, the parser cases, the `patcher.json` fixture). `bun test packages/coding-agent/test/tools/edit-handler-url-targets.test.ts` passes, and its new tagless `agent://` case fails on `main`'s addon.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
