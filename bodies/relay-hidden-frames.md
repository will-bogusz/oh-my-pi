## What

When the browser relay empties and hides another extension's frame in a tab omp drives, the call that ran into it now says which one. It gives the extension's name and id as Chrome reports them, the frame's page path (`inline/menu.html`, `notification.html`), and that the frame is hidden for the user too, so nothing was saved through it. It also asks the agent to pass that on. Until now the agent heard only that it might have been "a password manager's inline autofill menu", and a hidden save card was not mentioned at all, to the agent or to the user.

- The extension reads each emptied frame's id and path, keeps only frames of extensions Chrome has installed (`chrome.management.get`), and sends them to the relay. A frame `src` is page-authored, so decoy frames are dropped and the path is quoted and capped.
- The bridge forwards the frames to the worker with a session on the tab. If there is none, it holds them for the next worker (`OMP.takeHiddenFrames`).
- The worker hands them over with its ready report or with any run result, failed runs included. The supervisor tells the agent once.

## Why

A hidden "Save login?" card loses the user's chance to save a login, and before this nothing said so. Could such a card stay visible instead? Measured on Chrome for Testing 150 with a card frame in an attached tab: Chrome refused every debugger command and reattach, 10/10. So the relay keeps hiding cards and reports them instead.

| blind Claude Haiku 5.5 runs, sign-in on a fixture whose stand-in vault opens a card on submit | parent fix only | this PR |
|---|---|---|
| final message names the extension | 0/5 | 5/5 |
| says nothing was saved | 0/5 | 2/5 |

**Maintainer decision:** this adds the `management` permission, used only for the name lookup. The relay installs unpacked, so existing installs pick it up without a prompt. A Web Store build would need re-approval.

## Testing

`bun test packages/coding-agent/test/tools/browser-relay-tab-isolation.test.ts -t "password manager"`: the open names the menu frame, the submit names the card, and the call after says nothing. `browser-relay-foreign-frames.test.ts` covers decoy and malformed `src` values.

Not covered: frames held for a tab nobody re-adopts are told to whichever omp adopts it next.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
