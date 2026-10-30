## What

I'd like snapcompact to hold up when a session moves to a model that can't read images, since the archive's full text is already stored and we were throwing it away.

After a switch to a text-only model (GLM, DeepSeek, Grok Composer), recall of snapcompact-archived history goes from 0.27 to 0.93 on probe questions: the model reads the archive's stored text instead of image placeholders.

> **Snapcompact context.** An archive keeps old turns as plain text at both ends and as PNG "frames" of text in the middle. The whole kept source is also saved on the compaction entry (`archive.text`).

What a model without image input receives for the archive:

```text
main:     <summary: "Some middle sections: images…">  <text head>
          [image omitted: the active model does not support image input]  ×N
          <text tail>
this PR:  <summary without the frame legend>  <the archive's whole kept text>
```

Vision models get the frames as before.

## Why

`sdk.ts` turns every image into a placeholder for a model whose wire sends none, which drops an archive's middle although we hold its text. `SessionMaintenance` already swaps each archive summary for the view the current model may read (Claude's no-reasoning view, #15436) on every model change, before every model call and for side requests. This PR adds image input to that swap:

- `snapcompact.viewWithoutFrames`: `archive.text` as text, reasoning dropped for Claude-like readers without rendering frames, summary without the frame legend but with its own file list.
- `ArchiveReader` (`excludeThinking`, `withoutFrames`) in `session-maintenance.ts` replaces the bare reasoning flag. Any `snapcompact` summary qualifies, also one whose frames a budget already dropped.
- Compaction acceptance and the fallback fit check count the archive in the form the model is sent, so they compare text with text.

`buildSessionContext` takes no model, so I left it alone. The text goes whole; if it does not fit, the usual compaction handles it.

Non-goal: `images.blockImages` keeps its placeholders.

## Testing

| | `main` | this PR |
|---|---|---|
| Probe recall, 40 snapcompacted sessions under GLM-5.3 / Grok Composer | 0.27 (50 runs) | 0.93 (49 runs, flag prototype of the same substitution) |
| Live: one session copy (14 frames, 318K-char text) under `factory-droid/glm-5.3` | 10 placeholders, 27K input tokens, oldest probe UNKNOWN | 0 images, 110K input tokens, both probes right |

Recall: my sessions, judged probes on the archived history. The live run used this branch with the fix reverted for `main`, in an isolated agent dir.

- `agent-session-snapcompact-reader.test.ts`: GPT → DeepSeek → GPT (text, then frames), a text-only Claude side request (no reasoning, no frame render), a context built with every frame dropped, a soft compaction that shrinks the text but not the framed form (accepted), and `createAgentSession` under DeepSeek with stubbed fetch (no `[image omitted`). Each fails with its source change reverted.

```sh
bun test packages/coding-agent/test/agent-session-snapcompact-reader.test.ts packages/snapcompact/test/snapcompact.test.ts
```

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
