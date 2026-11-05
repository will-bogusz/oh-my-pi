## What

I made the busy error you get for clicking beside `tab.waitForDownload()` hand you a `tab.run` that does both, and put the same pattern next to `waitForDownload` in the browser prompt, because the old advice to await each call misses the download.

First-try downloads in a 5-run sample per model: Haiku 5.5 0/5 → 3/5, GPT-6.1 Sol 2/5 → 5/5.

```diff
 Tab "report" is busy:
-another call on this tab is still running. Await each call before starting the next instead of running them together (Promise.all, asyncio.gather), or group the steps in one tab.run(...)
+tab.waitForDownload() holds the tab until a download finishes, so the step that starts the download cannot run beside it. Start the wait and that step in one run: await tab.run("const download = tab.waitForDownload(); await tab.click('#export'); return await download;")
```

The browser tool prompt and `docs/tools/browser.md` gain one sentence after the downloads helpers: `waitForDownload` holds the tab until a file arrives, so start it and the click that downloads in one `tab.run`.

## Why

In Eval, each direct tab helper is its own run, and a tab runs one at a time. So the natural `const download = tab.waitForDownload(); await tab.click(sel); await download` fails at the click with `Tab … is busy`, and the error's advice is wrong for this one helper: on a tab opened without `downloads`, tracking starts at the first wait, so `await tab.click(sel)` then `await tab.waitForDownload()` times out with the file already saved. Inside one `tab.run` both steps share the run, and #14417 made a click right after the wait safe there.

Decisions:
- The refusal is specific only for a direct `waitForDownload` call (`runBrowser` marks it on the pending run). Every other busy error keeps #16149's text.
- The suggested run is a code string, so it pastes into Python Eval too.
- Not done: letting a direct `waitForDownload` run beside other calls. The tab worker runs one run at a time (`Tab worker is busy`), so that would change how tabs schedule work.

Closes #17615.

## Testing

- `browser-open-options.test.ts` "answers a click beside a direct waitForDownload with a run that downloads the file": starts a direct `waitForDownload`, clicks beside it, pastes the `tab.run` from the refusal and checks the downloaded bytes. On `main` it fails: the refusal carries no run to paste.
- Sample set, `main` against this branch, 5 runs each, thinking low, `omp -p` with a fresh agent dir: a local page whose "Export CSV" button downloads a CSV; task "download it through the button, report its path and the sum of a column". Scored from the transcripts by each download attempt's outcome:

| | first try downloads | busy errors | download attempts |
|---|---|---|---|
| Haiku 5.5, `main` | 0/5 | 6 | 12 |
| Haiku 5.5, this PR | 3/5 | 2 | 7 |
| GPT-6.1 Sol, `main` | 2/5 | 3 | 9 |
| GPT-6.1 Sol, this PR | 5/5 | 0 | 5 |

  Both busy errors on the branch were followed by the one-run pattern in the next cell, which downloaded the file.
- `browser-open-options`, `-tab-worker-startup`, `-tab-call`, `-run-cancellation`: 71 pass, on Linux.

```sh
bun test packages/coding-agent/test/tools/browser-open-options.test.ts -t "download"
```

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
