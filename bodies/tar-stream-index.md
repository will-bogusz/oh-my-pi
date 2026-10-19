## What

I kept hitting a raw Node buffer error reading anything inside a `.tar.gz` that decompresses past 256 MB, so I made those tarballs stream through the tar header walk instead of being inflated into one buffer.

A gzip or zstd tar past `maxInMemorySize` (256 MB) now lists and reads its members, where `main` fails both with `Cannot create a Buffer larger than 268435456 bytes`.

| Archive, decompressed | `main` | This PR |
|---|---|---|
| `.tar.gz` / `.tgz` / `.tar.zst`, up to 256 MB | indexed from one buffer | same path, same output |
| the same, past 256 MB | listing and every member read fail with the raw buffer error | lists; members up to the 64 MB member limit read |
| bare `.gz` / `.zst`, past 256 MB | the raw buffer error | `Archive is too large to read in memory (decompressed > 256.0MB limit)` |
| a past-256 MB tar holding a member over 64 MB | the raw buffer error | `Archive member '…' is too large to extract in memory`, raised while indexing |

Reading order: `streamedReader` (`ar/registry.ts`) → `readTarEntries`, `TarByteStream`, `TarStreamPayload` (`ar/tar.ts`) → `decodeByteSource` (`ar/source.ts`).

## Why

`compressedReader` inflated the whole stream with `maxOutputLength` at the in-memory limit, and Node's overflow error reached the user. A tar's index is only its headers; the stream need not be held.

Decisions:
- Output that fits keeps the old one-buffer path, so normal archives, their extraction and rewrites are untouched. Always streaming was rejected: each member read would decompress again.
- A streamed member read decompresses up to the member; a read ahead of the last continues that pass, so reading members in payload order (`extractArchive` of the 3,000-file archive below) costs one more pass, not one per member. Links to earlier payloads restart it.
- The index pass decompresses to the end, so gzip's CRC trailer is still checked.
- Memory: up to the limit while the first pass finds the stream too big (as on `main`), then the decoder's few 1 MB chunks plus the member being read, copied out of its chunk. Time grows with the decompressed size, as `tar -tzf` does.
- Raising the limit was rejected: it only moves the wall for untrusted archives.

The walker now reads a chunked `TarByteStream`, so `readTarEntriesFromBuffer` became async (Breaking Changes entry).

Non-goals: bzip2, xz, `.Z` and lzma tars (whole-buffer decoders that already name their limit), deb and rpm inner tars, plain `.tar` past 256 MB.

Related: #16024 drops the index-time member check in the last row.

## Testing

- Replayed my recorded `read` calls on tar, gzip and zstd archives that still exist (99 calls, 3 root sessions): the 94 that worked on `main` return byte-identical output. The 3 failures (335 and 498 MB decompressed) move to the member-cap error for a 176 MB member; with #16024 merged on top all 3 read, and neither PR alone does.
- Synthetic, via `ReadTool`, `main` → this PR: 300 MB `.tar.gz` and `.tar.zst`: listing and `:small.txt` (beside six 50 MB members) fail → work. 3,000 × 92 KB logs (287 MB): listing, first and last member, `extractArchive` of all fail → work (2.5 s). 300 MB non-tar `.gz`: raw error → limit message.
- Fitting archives open faster: 2.5, 5.6 and 200 MB-decompressed `.tar.gz` took 24–34, 153–249, 313–339 ms on `main`, 15, 41–49, 110–119 ms here (median of 9, two rounds).
- New tests in `test/ar/tar.test.ts`: 5 of 6 fail on `main`'s sources; dropping the drain, restarting every read, or returning the chunk view each fails its test. `bun test test/ar` (167 pass), `bun run check`, `check:ts`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
