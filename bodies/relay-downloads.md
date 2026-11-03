## What

I made relay tabs see their own downloads, so `waitForDownload()` stops failing and an agent no longer has to dig through chrome://downloads to find the file.

In a browser-relay tab, `tab.waitForDownload()` now returns the file where Chrome saved it, and `tab.downloads()` lists it even when the click came before any wait; on `main` the wait throws `Browser target is not found` and the list stays empty.

> **Relay context.** The relay drives the user's Chrome through an extension's `chrome.debugger`, one tab at a time. It has no browser-wide target, and Chrome refuses an extension's `Page.setDownloadBehavior`, so the relay can neither redirect downloads nor hear `Browser.downloadProgress`. The page's own sessions do get `Page.downloadWillBegin` and `Page.downloadProgress`, without the saved path.

| | `main` | this PR |
|---|---|---|
| `tab.waitForDownload()` in a relay tab | throws `Browser target is not found` | the file Chrome saved, real name and folder |
| `tab.downloads()` after a click | `[]` | every download the tab or its frames started since it opened |
| `browser.open({ downloads })` on the relay | opens a tab, then fails with `Browser target is not found` | refused before any tab opens |
| Managed, spawned and connected Chromium | | unchanged |

Reading order: `DownloadManager`, `buildInitPayload`, `RelayBridge.#replyDownloadPath`, the extension's `findDownload`.

## Why

In a FRED download task on GPT-6.1, OMP runs took 27 and 32 steps against Codex's 19 and 17, the extra steps spent in chrome://downloads after `waitForDownload` failed.

- Relay tabs (the supervisor flags them in the worker's init payload) listen to `Page.download*` on each frame's session, cross-site frames included. That changes no browser setting, so tracking starts when the tab opens.
- The saved path comes from the extension, `chrome.downloads.search({ finalUrl, state: "complete" })` newest first, which needs the `downloads` permission. Rejected: emulating a browser target in the bridge (a second fake session kind puppeteer would use for other things), and guessing the path from Chrome's folder (unknown, and clashes become `name (1).csv`).
- An older extension has no lookup, so the bridge tells the user to reinstall it. The relay's self-update reloads it with the new permission, which Chromium grants an unpacked extension without a prompt (`chrome_extension_registrar_delegate.cc`).

Non-goals: choosing the relay's download folder; Tern and cmux. Limit: if two downloads of one URL finish at the same moment, both waits may get the newer file's path.

## Testing

Headless Chromium running the real relay extension (`browser-relay-tab-isolation.test.ts`):
- a click before any wait, then one inside a cross-site iframe: each wait returns Chrome's path (`report.csv`, `report (1).csv`), the bytes read back, and `downloads()` lists both;
- two downloads of one URL held open by the server: the first resolves while the second still runs;
- an open with `downloads` is refused and Chrome's tab count is unchanged.

With the source reverted all three fail; without `state: "complete"` the second fails. Bridge tests cover a missing download and an older extension.

```
cd packages/coding-agent && bun test test/tools/browser-relay-tab-isolation.test.ts test/tools/browser-relay-bridge.test.ts test/tools/browser-open-options.test.ts
```

Not run: the self-update in a headed Chrome (headless drops any reloaded extension).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
