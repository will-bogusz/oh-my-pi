## What

[OWN WORDS: Will writes this sentence before the PR opens]

Chrome never updates the relay extension, since it is loaded unpacked: after an omp upgrade the old one runs until the user runs `omp browser-relay install` and clicks *Reload* (a Chrome restart is not enough). Now the relay does both.

| After an omp upgrade | main | this PR |
|---|---|---|
| loaded from `~/.omp/browser-relay/extension`, relay idle | old extension runs; opens note it | files rewritten, extension reloads and reconnects, no clicks |
| same, a session connected or a tab attached | same | waits; updates when the last client leaves |
| loaded from another folder | manual | unchanged |
| installed before this change | manual | one last manual update |

Reading order:
- `background.ts`: the hello says `reloadProtocol: 1`; a relay `{ t: "reload" }` calls `chrome.runtime.reload()`.
- `RelayBridge` (`bridge.ts`): `#maybeUpdateExtension` on each hello and when the last CDP client closes; not ready during the write, and the socket is retired as the reload is asked.
- `relay/server.ts`: the extension id comes from the `/ext` upgrade's `Origin`; `extensionUpdaterFor` writes, one call at a time, only when it is Chrome's id for the install folder and the files there are not from a newer omp.
- `relay/extension-files.ts`: what `install` writes (moved from `browser-relay-cli.ts`), each file renamed into place; Chromium's id derivation.

## Why

- Reload, not restart: a restart re-reads `manifest.json` but runs the old service worker; a reload re-reads the folder under the same id, keeping storage, permissions and the file-URL choice.
- A reload drops the extension's socket and debugger attachments, so it waits for no CDP client and no attached tab, and checks again after the write.
- Only the folder `install` owns, never over a newer omp's files, so two installed omps don't trade it back and forth.
- Atomic writes: a reload that meets a half-written manifest unloads the extension behind an error dialog.
- One reload per browser and version; an extension that comes back unchanged keeps the out-of-date note.
- Not the Web Store or an `update_url`: both need a listing or signed package someone maintains.

## Testing

- `browser-relay-self-update.test.ts`: which hellos update and which never do; waits for clients and attached tabs; nothing more reaches a browser asked to reload; once per version (A→B→A); real relay with files on disk: install folder rewritten, three profiles each reloaded, another folder and newer files left alone; Chromium's id fixtures (macOS/Linux and Windows). Removing any one guard fails its test.
- Live, branded Chrome 155 in a macOS VM, *Load unpacked* from `~/.omp/browser-relay/extension`, relays from this branch stamped 18.11.1 to 18.11.6:
  - new relay, nothing connected: `extension reloading into update`, back on the new version with the same instance id, file-URL toggle still off, no error in `chrome://extensions`. An open's wait started with the relay (`waitForRelayExtension`) returned `ready` 459 ms later, on the new version, with no note.
  - new relay, nothing connected: `extension reloading into update`, back on the new version with the same instance id, file-URL toggle still off, no error in `chrome://extensions`.
  - two CDP clients holding a puppeteer tab: `update deferred … CDP clients connected`, the tab kept working; 0.5 s after they left, the extension was on the new version.
- `bun test` on the relay files and `browser-open-lease`: 139 pass. `bun run check:ts` clean.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
