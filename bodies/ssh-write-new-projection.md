## What

Copying a bounded `read` result to a new `ssh://` file was dying with a `head` error about the very file being created, so I made a missing remote file count as new, the same as a local write.

`write` to a new `ssh://` file now creates it when the content ends with a `read` truncation notice, instead of failing with the remote `head: cannot open '<path>' for reading: No such file or directory`.

| `write` of a bounded `read` result to | `main` | this PR |
|---|---|---|
| a new local file | written | written (unchanged) |
| a new `ssh://` file | fails: `head: … No such file or directory` | written |
| an existing longer `ssh://` file | refused: incomplete read projection | refused (unchanged) |
| an existing `ssh://` file without read permission | fails: `head: … Permission denied` | fails (unchanged) |

## Why

Content ending in a truncation notice (`[Showing lines 1-20 of 60. Use :21 to continue]`) usually means a model copied a bounded `read`, e.g. eval's `tool.write({ path, content: (await tool.read({ path: src })).text })`. The write tool checks it against the current target so a partial copy can't replace a longer file. A missing disk target counts as no current source (ENOENT in `readCurrentWriteSource`). A handler-backed target goes through `router.resolve`, which for `ssh://` ends in `readRemoteFile`'s `head`, and its error became the write's result.

- `readRemoteFile` still runs `head` first. When it fails and nothing exists at the path (not even a dangling symlink), the remote command exits 66 (`EX_NOINPUT`) and the error carries `code: "ENOENT"`, with `head`'s stderr unchanged.
- `WriteTool`'s handler branch treats ENOENT from `router.resolve` as no current source. Other errors still fail the write.
- Rejected: trusting `statRemotePath`'s `missing`. Behind a login banner it reports every path missing (#14541), so an existing unreadable file would skip the check. Stdout noise can't fake an exit status.
- Rejected: catching every resolve error, which would skip the check for an existing file over the 1 MiB `ssh://` read limit.

Non-goals: refusing truncated content for new files (local writes accept it), and eval's `write()` helper, which refuses protocol paths by design.

## Testing

- Live on `ssh goliath` with the worktree's `ReadTool`/`WriteTool`, a 20-of-60-line read written to a new remote file: `main` fails with `head: cannot open '/home/will/tmp/…/live-….txt' for reading: No such file or directory`; this PR writes it. Over an existing 100-line file both refuse. A missing path resolves with `code=ENOENT`; a mode-`0200` file with `Permission denied` and no code. Released 18.16.0 fails the same from eval's `tool.write`.
- `write-read-projection.test.ts` runs the real `ssh://` shell commands locally (`fakeSshTransport`) for the new, longer and unreadable cases; with `src/` reverted it fails with the `head` error. The reviewer's banner-plus-unreadable-file probe keeps the original bytes.
- 156 tests across the `ssh://` suites pass; `bun run check:ts` passes.

---

- [ ] `bun check` passes
- [ ] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
