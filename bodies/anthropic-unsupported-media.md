## What

I made Claude turns that attach a video, PDF or HEIC fail with an error naming the format, because omp was quietly swapping the attachment for a text stub and billing a reply to a question the model couldn't see.

Live, Haiku 5.5 over `omp --mode rpc` with a real HEIC frame: `main` 3 of 3 billed replies saying it can't see an image; this PR 3 of 3 immediate errors, no request sent.

| Attachment Claude can't read (base64, not JPEG/PNG/GIF/WebP) | `main` | This PR |
|---|---|---|
| On the turn being answered (a `user` message, or a `/guided-goal`/`/ratchet` kickoff with pasted images) | text `[unsupported image: video/mp4]`, request sent | `Claude does not accept video/mp4 attachments; send JPEG, PNG, GIF or WebP images instead`, no request |
| On an earlier, answered turn | `[unsupported image: video/mp4]` | `[video/mp4 attachment omitted: not supported by this model]` |
| In a tool result, or in a compaction request | `[unsupported image: …]` | the omission note; never fails |

Non-goals: converting decodable formats (HEIC, TIFF, BMP) to PNG instead of failing. `Bun.Image` decodes HEIC and TIFF only with an OS codec (macOS yes, Linux no), so it can't be the general answer; the coding agent's own attachment paths already convert where they can.

## Why

The coding agent drops undecodable bytes before the provider, but a decodable HEIC/BMP/TIFF sent over RPC or the SDK, and video or PDF from SDK callers, reached `convertContentBlocks`, which turned them into a stub and sent the request. The model then answers as if the user never attached anything.

Decisions:
- Only the turn being answered fails: the last message that started a run (`user`, or a `synthetic`/user-attributed `developer` prompt) with no assistant reply after it. Failing on history would fail every later request in the session; after the error, the user's next prompt (or the continue shortcut) makes that turn history and the session carries on.
- Tool results never fail: the tool's output stays in context, so failing on it would repeat on every retry.
- This matches Bedrock, whose `createImageBlock` already throws `ValidationError` for an unknown image type; the error is a `ValidationError`, so it is not retried.

Cost: sessions that already hold a `[unsupported image: …]` stub send different bytes for that block once after upgrade (one prompt-cache miss for those sessions only).

## Testing

- Live (Haiku 5.5, `--thinking off`, `omp --mode rpc` from each worktree), 3 runs per arm: decodable HEIC `main` 3/3 replies / PR 3/3 errors with 0 input tokens; a follow-up text prompt after the error succeeds on the PR. Undecodable video/PDF/HEIC bytes: 6/6 identical replies on both arms, because the coding agent's guard drops them first.
- `bun test packages/ai/test/anthropic-unsupported-media.test.ts`: 11 pass. With `anthropic.ts` reverted to `main`, 10 fail (the JPEG pass-through case passes on both).
- `bun test packages/ai/test/anthropic*`: all pass.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
