## What

Follow-up to #16288: the Factory image budget dropped a computer-use screenshot but the request still carried a second copy of it, so I made the budget count the copy that is sent and drop both together.

A Factory GPT turn after five 1 MB computer screenshots goes from 5,001,949 bytes on `main` (over Factory's 4,500,000-byte limit, HTTP 413) to 3,001,803 bytes.

| Factory GPT/Grok request after an OpenAI computer-use session | `main` | This PR |
|---|---|---|
| Five 1 MB screenshots | 5,001,949 bytes: all five sent, 413 | 3,001,803 bytes: newest three sent, older two as their result text |
| Five 1 MB screenshots held only in the result's metadata | 5,001,949 bytes, 413 | 3,001,803 bytes |
| One 1 MB screenshot, then a fresh 3.6 MB pasted image | fresh image dropped though it fits | fresh image kept, 3,600,788 bytes |

## Why

> **Computer-use context.** A `computer` tool result can store its screenshot twice: as the result's image, and in `providerMetadata.screenshot`, the form OpenAI's Responses API takes back. On Responses routes the request sends the metadata copy, not the image: a `computer_call_output`, or, on a model without native computer use (Factory's GPT and Grok), an assistant note quoting it (`appendResponsesToolResultMessages`).

#16288's byte clamp counted and evicted only the image copy, so the metadata copy still went out. Codex found this on #16288 after it merged ([review](https://github.com/can1357/oh-my-pi/pull/16288#pullrequestreview-5589040880)).

- `computerScreenshotExtraBytes` charges a computer result whatever its inline metadata screenshot adds beyond its content image, so the result costs its larger copy whichever one the route sends. The two copies need not match: a small preview beside a full screenshot, or a metadata-only screenshot, is charged in full.
- `clampToolResultMessage` drops a computer result's metadata when it evicts that result's image, so the result goes out as its remaining text. `dropUnreadableContextImages` already does this for an undecodable screenshot.
- The room reserved for the newest images no longer counts the metadata copy a second time, which had evicted a fresh image that fit.

Rejected: unrolling computer history into function calls in the Responses serializer, as the Codex provider does. That changes every Responses route without native computer use, and the remote-compaction tests pin the note form.

Non-goal: on a model without computer use, the kept screenshots still reach the model as a data URI inside a text note, as on `main`.

## Testing

Four cases in `packages/coding-agent/test/session/provider-image-budget.test.ts` build an OpenAI computer-use transcript, clamp it for a Factory `gpt-5.6-terra` model, send it through `streamFactoryDroid` with a capturing `fetch`, and measure the request body as sent: matching copies, metadata-only screenshots, a fresh image after a screenshot, and a 1 KB preview beside a 1 MB metadata screenshot. With the fix reverted all four fail (5,001,949 bytes, or the fresh image evicted). Negative control: the kept screenshots are still in the body, and no `function_call_output` is left without its call.

```sh
cd packages/coding-agent && bun test test/session/provider-image-budget.test.ts   # 50 pass
```

`bun run check` in `packages/coding-agent` passes (oxlint, oxfmt, tsgo).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
