## What

Follow-up to #16288: the Factory image budget dropped a computer-use screenshot but the request still carried a second copy of it, so I made the budget count the copy that is sent and drop both together.

After five 1 MB computer screenshots, a Factory GPT request goes from 5,001,949 bytes on `main` (over Factory's 4,500,000-byte limit, HTTP 413) to 3,001,803.

| Factory GPT/Grok request after an OpenAI computer-use session | `main` | This PR |
|---|---|---|
| Five 1 MB screenshots | 5,001,949 bytes: all five sent, 413 | 3,001,803 bytes: newest three sent, older two as their result text |
| Five 1 MB screenshots held only in the result's metadata | 5,001,949 bytes, 413 | 3,001,803 bytes |
| One 1 MB screenshot, then a fresh 3.6 MB pasted image | fresh image dropped though it fits | fresh image kept, 3,600,788 bytes |

## Why

> **Computer-use context.** A `computer` tool result can store its screenshot twice: as the result's image, and in `providerMetadata.screenshot`, the form OpenAI's Responses API takes back. On Responses routes the request sends the metadata copy, not the image: a `computer_call_output`, or, on a model without native computer use (Factory's GPT and Grok), an assistant note quoting it (`appendResponsesToolResultMessages`).

#16288's byte clamp counted and evicted only the image copy, so the metadata copy still went out. Codex found this on #16288 after it merged ([review](https://github.com/can1357/oh-my-pi/pull/16288#pullrequestreview-5589040880)).

- On a route that sends the metadata copy (the Responses wire, Factory GPT/Grok included), both image clamps count a computer result as one image costing that copy's bytes; its content, never sent there, is not charged (`sentScreenshotBytes`). Mismatched copies (a small preview beside a full screenshot, metadata only, a large content image beside a small screenshot) each cost what is sent. Routes that send only the content (Messages, Factory Claude) are clamped as on `main`.
- Evicting that screenshot drops both copies, so the result goes out as its remaining text. `dropUnreadableContextImages` already drops the metadata this way for an undecodable screenshot.
- The room reserved for the newest images counts each screenshot once, as sent, where it had also counted the metadata copy and evicted a fresh image that fit.

Rejected: unrolling computer history into function calls in the Responses serializer, as the Codex provider does. That changes every Responses route without native computer use, and the remote-compaction tests pin the note form.

Non-goal: on a model without computer use, the kept screenshots still reach the model as a data URI inside a text note, as on `main`.

## Testing

Seven cases in `packages/coding-agent/test/session/provider-image-budget.test.ts` clamp an OpenAI computer-use transcript for Factory `gpt-5.6-terra`, send it through `streamFactoryDroid` with a capturing `fetch`, and measure the body as sent. With the fix reverted the first four fail (5,001,949 bytes, or the fresh image evicted). Cases and negative controls are in the details below.

<details><summary>Cases and negative controls</summary>

Cases: matching copies, metadata-only screenshots, a fresh image after a screenshot, a 1 KB preview beside a 1 MB metadata screenshot, a 4 MB content image beside a 1 KB metadata screenshot, 1 MB of unsent result text, and six content thumbnails against Factory's five-image count.

Negative controls: the kept screenshots are still in the body, no `function_call_output` is left without its call, and two content-only cases (Factory Claude with 1 KB thumbnails beside 1 MB metadata; a 1 MB screenshot plus a 23 MB image at Anthropic's 24 MB budget) keep every image.

</details>

```sh
cd packages/coding-agent && bun test test/session/provider-image-budget.test.ts   # 55 pass
```

`bun run check` in `packages/coding-agent` passes (oxlint, oxfmt, tsgo).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)




