## What

The read tool could keep showing an archive's old listing after the file was rewritten at the same size within a millisecond or so, and that same race is why the restored-mtime archive test flakes on Linux, so I made the archive cache skip anything changed in the last two seconds, the way grep's snapshot stamps already do.

On Linux 6.8 / ext4 the existing test `re-reads an archive rewritten in place with the same size and restored mtime` fails in 16 of 20 runs of `tools.test.ts` on `main` and in none of 60 with this change.

- `openArchiveCached` (`tools/read-archive.ts`) memoizes a reader only when the archive's ctime is at least `RACY_IDENTITY_WINDOW_MS` (2 s) older than a clock read taken before the stat.
- New test `re-reads an archive rewritten in place within one timestamp granule` fakes that filesystem on any platform.

Non-goals: the cache's key, bounds and formats, and grep's stamps, are unchanged.

## Why

The archive cache from #14701 reuses a parsed archive while inode, mtime, ctime and size all match. Before multigrain timestamps (Linux 6.13), ext4, xfs and tmpfs take ctime from the kernel's coarse clock, so a write, a `read` and a same-size rewrite inside one tick leave all four unchanged, and the second `read` serves the first archive. On a HZ=1000 host, write, stat, same-size rewrite, stat keeps the whole stat identical in 972 of 1,000 loops. Alone, the test's first `read` is cold and outlasts the tick, so it passes alone and fails beside its neighbours.

Git's racy-clean rule closes this: a stat younger than the timestamp granule can't vouch for the content. grep's snapshot stamps (#14702) already apply it with the same 2 s window, which also covers 1–2 s granules (HFS+, FAT). The cost is a re-index for reads within 2 s of an archive's last change, the same as a cache miss on `main`.

Decisions:
- ctime only, not `max(mtime, ctime)`: ctime records the last change, while `utimes` can set mtime anywhere, and a future mtime would only switch the cache off for that file.
- Fix the cache, not the test: the test caught a real stale read, which agent sessions hit the same way (write an archive, `read` it, rewrite it, `read` again).

## Testing

| `bun test test/tools.test.ts` (Linux 6.8, ext4) | `main` | this PR |
|---|---|---|
| existing restored-mtime test, alone (`-t`) | 20/20 pass | 20/20 pass |
| existing test, in the whole file | 4/20 pass | 60/60 pass |
| new granule test, alone / in the whole file | 0/10 / 0/10 pass | 20/20 / 60/60 pass |

One of the 60 whole-file runs with this change ended in a Bun SIGBUS crash in a later search test, after both archive tests passed.

- The new test spies `BunFile.prototype.stat` to return the first write's stat for the archive and pins the clock with `setSystemTime` to that stat's ctime, so its result does not depend on machine speed. With the `read-archive.ts` change reverted it fails on Linux and macOS (`Received: "alpha.txt (6B)"`).
- macOS (APFS, nanosecond timestamps): whole `tools.test.ts` 149/149; the existing test passes there on `main` too.
- `bun run check` in `packages/coding-agent`.

Re-run on a Linux kernel before 6.13: `cd packages/coding-agent && for i in $(seq 20); do bun test test/tools.test.ts >/dev/null 2>&1 && echo pass || echo fail; done | sort | uniq -c`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
