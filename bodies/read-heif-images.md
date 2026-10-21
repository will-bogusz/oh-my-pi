## What

`read` on an iPhone photo said `[Cannot read binary file 'photo.heic' …; not valid UTF-8 text]`, so an agent had to convert it first; I made HEIC, HEIF and AVIF stills show as images, decoded by the ffmpeg that video reads already use.

| `read photo.heic` | main | this PR |
|---|---|---|
| vision model, ffmpeg 8.1+ | binary refusal | `Read image file [image/heic] (displayed as image/webp)` + the image, resized like any PNG (4032x3024 → 1568x1176, coordinate note included) |
| text-only model | binary refusal | `Image metadata: MIME image/heic …` + the `?q=` hint |
| `photo.heic?q=…` | binary refusal | answered by the vision model |
| ffmpeg missing or older than 8.1 | binary refusal | `Could not decode HEIC image. Convert it to PNG or JPEG (e.g. sips -s format png on macOS) and read that file.` + the cause |

**Beyond the decode:** the `ffmpeg -version` probe behind `-fps_mode`/`-vsync` moved into a shared `ffmpegRelease()`; it now also parses BtbN-style `n8.1` version strings, which main read as unknown.

## Why

Phones save photos as HEIC, and the image pipeline decodes only PNG, JPEG, GIF and WebP. `parseHeifImageMimeType` recognises the file by its `ftyp` brands (not its extension), and `loadHeifImageInput` feeds ffmpeg's full-resolution JPEG into the same `loadInMemoryImageInput` that SVG rasterization uses, so the size cap, resize, `?q=` and text-only branches are shared.

Decisions:
- **ffmpeg 8.1 or newer.** Camera photos are tiled (the 4032x3024 test photo is 12 HEVC tiles). ffmpeg 7.0.2 opens them and returns one 1024x1024 tile with exit 0; the CLI assembles tiles only since 8.1 ("ffmpeg CLI tiled HEIF support" in its changelog). Older releases get the conversion error instead of a wrong picture. AVIF shares the gate because AVIF can be tiled too.
- **JPEG, not PNG, as the intermediate.** A 6016x6016 HEIC decodes to a 50 MB PNG, past the 20 MB image cap; as JPEG it is 2 MB, and the true dimensions reach the resize note.
- **No macOS `sips` path.** It would cover Macs without ffmpeg but adds a second decoder; the error names it instead.

Maintenance: if a future ffmpeg changes tile handling, the 1100x8 tiled fixture test fails on that machine (it asserts the decoded width).

Non-goals: HEIC from URLs, prompt attachments, and the `read` tool prompt are unchanged.

## Testing

- `test/tools/read-local-image.test.ts` adds a tiled 1100x8 HEIC and a 16x8 AVIF. A probe classifies the machine's ffmpeg by decoding the tiled fixture, and each case runs where it applies. On goliath, PATH set to each build:

  | ffmpeg | decodes whole (HEIC, AVIF) | refuses one-tile decode | metadata, conversion error, MP4 stays binary |
  |---|---|---|---|
  | 6.1.1 (Ubuntu 24.04) | skipped | skipped | pass |
  | 7.0.2 | skipped | pass | pass |
  | 8.1.3 | pass (1100x8, 16x8) | skipped | pass |

  With main's sources, 4 of the new tests fail. With the version gate disabled under 7.0.2, the refusal test fails.
- Ground-truth harness (140 cases through a real `AgentSession`): `read:image-heic` goes from a binary refusal to an image block. The other 139 are unchanged.
- `read-video`, `utils/video`, `image-input`, `read*` and `fetch*` tests under ffmpeg 8.1: 206 pass, 1 skip (the 7.x refusal case). `tsgo` is clean for coding-agent and utils, and oxlint/oxfmt are clean.
- Live `ReadTool` on goliath, ffmpeg 8.1: a 4032x3024 tiled HEIC from `sips` gives `original 4032x3024, displayed at 1568x1176`, and an AVIF comes back as an image. A 21 MB HEIC stops at the existing `Image file too large` check.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
