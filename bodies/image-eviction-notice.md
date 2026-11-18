## What

I made the image omission note from 3967d6bcc63 reach evicted computer-use results on the Responses route too, which it skipped, putting it ahead of their text so the route's truncation can't cut it.

| An evicted computer result on a Responses route (OpenAI, Azure, Factory GPT, Codex with native computer use) | `main` | This PR |
|---|---|---|
| with text | its text only, no sign the screenshot was dropped | `[1 image omitted: provider image limit]`, then its text |
| with text over 16,000 characters | its text, cut at 16,000 | the note, then the text cut at 16,000: the note survives the cut |
| without text | `[image omitted: provider image limit]` | unchanged |

## Why

3967d6bcc63 made every message that keeps other content say how many of its images the clamp dropped (`clampContent`). On a route that sends a computer result's metadata screenshot instead of its content, eviction goes through `clampToolResultMessage` instead, which returns the result's text alone, so the model reads it as a complete result.

Decisions:
- **The note leads instead of trailing as in `clampContent`**: the Responses wire folds an evicted result into an assistant note and truncates its text to 16,000 characters from the end (`appendResponsesToolResultMessages`), so a trailing note would be cut from exactly the long results.
- **Main's wording, shared through one helper** (`omittedImages`) instead of a second copy of the template.
- **No new byte accounting**: the note is part of the fallback text the byte clamp already measures and charges against a request body limit.

Non-goals: the note's position and count elsewhere stay as `main` has them.

## Testing

`bun test packages/coding-agent/test/session/provider-image-budget.test.ts packages/coding-agent/test/provider-image-integrity.test.ts`: 88 pass. "evicts more computer screenshots when the text the evicted ones send crowds the rest" (200 Factory GPT computer results with 20,000-character texts, oldest evicted) now also asserts the serialized request carries `call_id=call_0]: [1 image omitted: provider image limit]`; with the source change reverted it fails. `bun run check:types` in `coding-agent` is clean; `bun check` at the root fails on oxfmt in six files this PR does not touch.

No CHANGELOG line: 3967d6bcc63 is unreleased, and its `[Unreleased]` entry already says dropped images are noted.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
