## What

I made the relay say what it hid. When it empties another extension's frame in a tab omp drives, the call that ran into it now leads with "Nothing was saved". It then names the frame's page (`inline/notification.html`), the extension's id and the page's own `<title>`, labelled as the page's own words ("the extension whose page calls itself "1Password""). Before this, the agent heard only "a password manager's inline autofill menu", and a hidden save card went unmentioned.

- **Unforgeable, no new permission.** A frame `src` is written by the page. So the extension fetches each emptied `chrome-extension://<id>/<path>` from inside that page and reports only frames that load. That means only an installed extension's page exposed to the site, the only kind that could have been drawn there. The id and path come from the URL that loaded, never the `src`. Paths are cut to 100 characters and titles to 60, and both are quoted. The probe runs in the extension's own world, injected at once and bounded at 750 ms.
- **Told once.** The bridge forwards the frames to the worker with a session on the tab, or holds them for the next worker (`OMP.takeHiddenFrames`). Any run result, failed runs included, carries them to the supervisor.

## Why

A hidden "Save login?" card costs the user that save, and nothing said so. It cannot stay visible: with a card frame in an attached tab, Chrome refused every debugger command and reattach, 10/10.

Blind Claude Haiku 5.5 runs, signing in through the relay. The fixture's stand-in vault draws a save card on submit, and its page is titled like 1Password's own pages (`<title>1Password</title>`):

| final message | parent fix only | name from `management` | this PR, title as a trailing clause | this PR, "Nothing was saved" first, title-led name |
|---|---|---|---|---|
| identifies the extension | 0/5 | 5/5 | 0/5 | 5/5 |
| says nothing was saved | 0/5 | 1/5 | 1/5 | 1/5 |
| claims a login was saved | 0/5 | 0/5 | 0/5 | 0/5 |

This PR ships the last column. Leading with "Nothing was saved" did not move that row, and no run claimed a save. One third-column run stopped early on the fixture's outdated-extension warning.

**Optional add for the maintainer:** the `management` permission would give Chrome's name for the extension instead of the page's title. A new install would then warn "Manage your apps, extensions, and themes".

## Testing

`bun test packages/coding-agent/test/tools/browser-relay-tab-isolation.test.ts -t "password manager"`: the open names the menu frame, the submit names the card, and the next call is silent. Frames the page plants are emptied and never reported: one to an uninstalled id, one to a page the vault does not expose, and a `/../` path that carries page text; with the probe bypassed, the test fails. `browser-relay-foreign-frames.test.ts` covers malformed `src`, duplicates and the title cap.

Not covered: pages served with `use_dynamic_url` are hidden but not reported; frames held for a tab nobody re-adopts are told to the next omp that adopts it.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
