## What

I made the relay tell the agent when it hides a password manager's frame, so the agent can tell the user their "Save login?" card is gone and nothing was saved.

Against a signed-in 1Password, every call that ran into a hidden frame now says so and names 1Password, and the tab is kept exactly as often as on `main`:

| 10 tries each, Chrome 157, 1Password 8.12.44.33 | tab kept, `main` / this PR | next call ok, `main` / this PR | this PR: names "1Password" |
|---|---|---|---|
| fill and submit, "Save login?" card | 10 / 10 | 10 / 10 | 10: the card on the failing submit, the sign-in frame on the open |
| Log in button opens the login page, field focused | 10 / 10 | 10 / 10 | 9 (9 tries drew a frame), on the failing click |
| open a login page, field focused on load | 10 / 10 | 10 / 10 | 8 (8 drew), on the open |
| type username, then password | 10 / 10 | 10 / 10 | 10, on the open |
| click the username field and type | 10 / 10 | 10 / 10 | 10, on the open |
| refocus the fields 3 times | 10 / 10 | 10 / 10 | 10, on the open |
| adopt a login popup | 10 / 10 | 4 / 8 | 0 |
| page without a login field | 10 / 10 | 10 / 10 | 0 |

Each hidden frame is named once. Popup adoption failed only in tries where 1Password drew a frame (6 on `main`, 2 here), as on `main`.

The notice leads with "Nothing was saved", then names the frame's page, the extension's id and the page's own title, labelled as the page's words ("the extension whose page calls itself "1Password""), and says the frame is hidden for the user too.

- **Reporting only.** `main`'s sweep and retry are unchanged; the identity check runs beside them. Holding the reattach behind the emptying is what loses the tab against 1Password.
- **Unforgeable, no new permission.** A frame `src` is page-written, so the extension fetches each emptied URL from the tab's own frame, in its isolated world, and reports only pages that load: an installed extension's page exposed to the site. Id and path come from the loaded URL; paths are cut to 100 characters, titles to 60, both quoted.
- **Told once.** The bridge holds what was hidden on the tab. The worker driving it takes it when it adopts the tab, or with the result of the run it was told during; a worker Chrome detached takes nothing, so the one that re-adopts the tab does.

## Why

The agent heard only "a password manager's inline autofill menu", and a hidden save card went unmentioned. The card cannot stay visible: with it in an attached tab Chrome refuses every debugger command.

Blind Claude Haiku 5.5 runs with a stand-in vault whose card page is titled `1Password`, measured on an earlier base with this same notice text:

| final message | without this PR | this PR |
|---|---|---|
| identifies the extension | 0/5 | 5/5 |
| says nothing was saved | 0/5 | 1/5 |
| claims a login was saved | 0/5 | 0/5 |

**Optional add for the maintainer:** the `management` permission would give Chrome's name for the extension instead of the page's title. A new install would then warn "Manage your apps, extensions, and themes".

## Testing

`bun test packages/coding-agent/test/tools/browser-relay`, in order and with `--randomize` seeds 1 to 10: all pass. A stand-in vault's save card is named once with its title; frames the page plants (an uninstalled id, a page the vault does not expose, a `/../` path carrying page text, the relay's own page) are emptied and never named. Unit tests fail if the probe holds the retry, if one gone frame drops the others' report, or if the bridge hands what was hidden to the worker Chrome detached instead of the one that re-adopts the tab. The fixture now awaits each `browser.installExtension`; Puppeteer's `enableExtensions` list is not awaited.

Not covered: frames held for a tab nobody adopts again are told to the next omp that adopts it; a report that lands after the last call on a tab is never shown; the identity fetch runs in the driven tab, so it may appear in that tab's captured network requests.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
