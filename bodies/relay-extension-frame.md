## What

I made the relay extension empty another extension's frame in a tab omp drives when Chrome refuses omp's debugger because of it, so a password manager's autofill menu no longer locks omp out of that tab.

| | `main` | this PR |
|---|---|---|
| the call that focused the credential field | fails (Chrome detaches omp) | fails, the tab is reattached |
| later calls on the tab | tab released; reopen fails with `Cannot access a chrome-extension:// URL of different extension` | work: the password filled again lands and the form submits |
| the user's other tabs with a menu open | menu kept | menu kept |

**Maintainer decision: the extension gains `scripting` and `<all_urls>`** (Chrome lists "Read and change all your data on all websites"). It uses them only after Chrome refuses an attach or command over another extension's frame, and only in a tab an omp connection claims; `debugger` already reaches any page it attaches to. Existing installs pick it up after `omp browser-relay install` and a reload.

The bridge decides, the extension executes: `RelayBridge#rpc` sets `clearForeignFrames` on `attach`/`send` for claimed tabs, and `pastForeignFrames` then points every foreign `chrome-extension://` iframe in the tab (closed shadow roots included) at an empty `srcdoc` and retries. A worker adopting a relay tab now claims it as it connects (`/cdp?claim=<targetId>`, replacing `OMP.claimTarget` after adoption), because puppeteer's connect already sends the tab commands; a claim also lifts a foreign-frame refusal.

## Why

While any frame of a tab shows another extension's page, Chrome fails `attach` and every `sendCommand` before dispatching (`debugger_api.cc`, `ExtensionMayAttachToWebContents`), so a retried command runs once. Password managers draw inline menus that way and keep them while the field has focus.

- `srcdoc` outranks `src`, so a vendor re-pointing the frame loads nothing, and its element stays in its DOM.
- Only claimed tabs: puppeteer sends commands to every attached tab, so an unconditional sweep emptied menus the user was using.
- Out of scope, as on `main`: the detach when the frame loads (the call that focused the field still fails once), a relay-initiated detach under a menu, and a tab whose menu was open before omp adopted it.

## Testing

Relay harness, Chrome for Testing 153/154 headless, relay extension plus a test extension injecting a menu iframe beside a focused password field inside a cross-site sign-in frame; calls through the browser tool's prelude. `main`: nothing posts until the user presses Escape. This PR: the second fill and Next post the password, no user action (2/2).

`bun test packages/coding-agent/test/tools/browser-relay-tab-isolation.test.ts -t "password manager"` (real extension, menu in a closed shadow root): the driven tab's second fill lands and its menu is emptied; the user's tab keeps its menu. Fails on `main` and with the sweep unconditional.

Not run: branded Chrome with a signed-in password manager.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
