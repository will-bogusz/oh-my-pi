## What

I made `waitForDownload` fail when the file it is about to report isn't on omp's machine, because with a browser on another machine it handed agents a path that does not exist.

`tab.waitForDownload()` now resolves only once a regular file is at the path the download was saved to. Otherwise the wait fails naming that path (`Download failed: <url>: the browser finished it, but no file is at <path> on this machine`), or the next wait does when none is waiting yet, as a relay download whose file cannot be found already does.

| Download | Before | Now |
|---|---|---|
| File saved on omp's machine | its path | its path |
| Browser at `app.cdp_url` on another machine saved it there | a local path with no file behind it, after a 1 s wait, also listed by `tab.downloads()` | the wait fails naming the path; not listed |
| A directory sits at that path | the directory's path | the wait fails at once; the directory is left alone |

## Why

`DownloadManager.#complete` polled `fs.stat` for up to a second, ignored the result, and reported the download either way. An agent then reads or uploads the file and fails a step later on an ENOENT that looks unrelated. The poll stays for a missing file, since Chromium's rename into place can lag its completed event; anything else at the path ends it at once.

The directory case was already refused for moving (`canMoveDownload`); it is now refused for reporting too, which changes the expectation of one existing test.

Non-goal: fetching a remote browser's file to this machine.

## Testing

- Against `main`, headless Chrome on a Linux host reached through `app.cdp_url` from omp on macOS: `waitForDownload` returned `/tmp/cbm-dl-…/fixture.bin` after about 1.4 s, and no such file existed on the omp host, 3 of 3.
- `browser-open-options.test.ts` "fails the wait on a completed download whose file is not on this machine, as a remote browser's is" and the updated "leaves a directory named by a UUID GUID in place and fails the wait" fail with the fix reverted (both waits resolve) and pass with it; the file's real-Chrome download tests still pass (30 of 30, twice). `bun test test/tools/browser-open-options.test.ts`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
