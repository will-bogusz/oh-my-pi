## What

I wanted agents to be able to pull what's said in a recording with timestamps, so `read` now transcribes audio files and video soundtracks with a model you're already logged in to that hears audio, with no download and no setting.

Haiku 5.5 answering questions about three recordings got 34/39 right on `main` at 113k–250k tokens a task, pip-installing a speech recognizer in every run, and 38/39 with this PR at 30k–62k tokens.

| Read | `main` | This PR |
|---|---|---|
| `read talk.mp3` (mp3/wav/m4a/flac/ogg/opus/…) | `Cannot read binary file … not valid UTF-8 text` | timestamped transcript, one `[m:ss.s-m:ss.s] text` line per sentence |
| `read clip.mp4:transcript` | `Path 'clip.mp4:transcript' not found` | transcript of the soundtrack; its times are frame selectors (`clip.mp4:1:14.6`) |
| bare `read clip.mp4` with a soundtrack | frames only | also names `:transcript` |
| no model hears audio, or `images.blockImages` is on | as above | duration, codec and size plus why there is no transcript; the prompt and video hint don't mention transcripts |

"Hears audio" is catalog data: `Model.input` can include `audio`. KDL gives it to Gemini on Google's transports (Antigravity, Gemini CLI, Vertex, API key); OpenRouter discovery keeps it for every model listed with audio input. The model is picked like `read img.png?q=` picks its vision model: `@vision`, `@default`, the active model, the active provider's, then any.

Supersedes #13826.

## Why

Agents can't hear: audio is refused as binary and video reads return frames only, so on `main` Haiku installs faster-whisper or Vosk and still answered 1/6 on a 17-minute speech.

- **A model the user already has, not a local one.** #13826 ran the dictation models on-device behind a setting and a 680 MB download, and scored 31/39.
- **ffmpeg alone isn't enough.** Speech-region metadata without words scored 19/26.
- **Audio rides the existing inline block.** `ImageContent` carries an `audio/*` MIME type: Google sends it as inline data, Chat Completions and Responses as an `input_audio` part. `audioInputMimeType()` names the encoding only where the model's `input` has `audio` and its transport carries it. A dedicated content type would touch every provider; Related: #10669.

Non-goals: speaker labels, transcript paging, local models.

Maintenance: if a host stops taking inline audio, the read fails naming the model; drop `audio` from its rule.

Reading order: `INPUT_MODALITIES` and `classes/gemini.kdl` (`models.json`: only `input` changes, on 70 Gemini rows) → `audioInputMimeType` and the two `input_audio` converters → `utils/media-transcript.ts` → `#readTranscript` in `tools/read.ts`.

## Testing

Live `omp -p` reads of a 1:50 two-voice standup (five facts, "lighthouse" spoken at 1:16.6); timestamps are only as good as the model:

| Transcribing model | Transport | Facts | "lighthouse" |
|---|---|---|---|
| `google-antigravity/gemini-2.5-flash` | GenerateContent, Opus | 5/5 | 1:14.1 |
| `openrouter/qwen/qwen3.8-omni-flash` | Responses, mp3 | 5/5 | 1:14.6 |
| `openrouter/thinkingmachines/inkling-small` | Responses, mp3 | 5/5 | 1:18.1 |
| `openrouter/openai/gpt-audio-mini` | Responses, mp3 | 5/5 | 0:42.0 (wrong) |
| `openrouter/xiaomi/mimo-v2.6-flash` | Responses, mp3 | fails with `returned no transcript text`: at minimal effort it answers only in its reasoning | |

Agent eval: Haiku 5.5 answering every question about each recording in one sandboxed `omp -p` run, n=3 per cell, regex answer keys:

| Recording | `main` | #13826 local Parakeet | ffmpeg speech regions | This PR |
|---|---|---|---|---|
| standup, 1:50 (6 questions) | 18/18, 113k tok, 72 s | 12/18, 30k, 38 s | 11/12 (n=2), 145k, 128 s | 17/18, 30k, 12 s |
| speech, 17:40 (2 timed questions) | 1/6, 185k, 366 s | 4/6, 35k, 360 s | 4/4 (n=2), 209k, 160 s | 6/6, 38k, 42 s |
| briefing video, 1:20 (5, two need audio) | 15/15, 250k, 83 s | 15/15, 47k, 33 s | 4/10 (n=2), 164k, 24 s | 15/15, 62k, 19 s |

Tokens and time are medians per run; the transcription request adds 3k, 32k and 2k Gemini tokens. GPT-6-luna with this design's prototype: 17/18, 6/6, 15/15, against `main`'s 6/24, 2/8, 8/20 (n=4).

New tests: catalog `audio-input.test.ts` (KDL rule, bundled rows, OpenRouter discovery through merge and cache reload), ai `audio-input.test.ts` (gate, three wire shapes), coding-agent `read-audio-transcript.test.ts` (Gemini and OpenRouter transcripts, no model, `blockImages`, empty, untimed and cut answers, Gemini on Copilot, parser shapes). With `src/` reset to `main` all three fail. `check:ts` clean; catalog 1239/1239, ai 6147 pass, read/video/models 249/249.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
