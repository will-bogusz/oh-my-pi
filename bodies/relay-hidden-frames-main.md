## What

I made the relay tell the agent when it hides a password manager's frame, so the agent can tell the user their "Save login?" card is gone and nothing was saved.

On head `8b646ad6c2d` against `main` `6e9204c9ee4`, a signed-in Web Store 1Password kept all 60 tabs on each build. The head named all 37 emptied frames "1Password" once, with no missing or repeated frame names; main and the no-login control emitted none.

Chrome stable **157.0.8103.79**, 1Password **8.12.44.33**; 10 tries per row. Pairs below are main / head. Both the inline login card and "Save login?" card were visually confirmed before the runs.

| Cell | tab kept | key call ok | next call ok | tries drawing the relevant frame | head: named frames, call |
|---|---|---|---|---|---|
| autofocus | 10 / 10 | 10 / 10 | 8 / 10 | 9 / 6 | 6 inline, open |
| Log in button loads focused field | 10 / 10 | 0 / 0 | 10 / 10 | 7 / 5 | 5 inline, failing click |
| type username then password | 10 / 10 | 9 / 10 | 10 / 10 | 9 / 7 | 7 inline, open |
| fill and submit | 10 / 10 | 0 / 0 | 10 / 10 | 9 / 9 save cards | 10 inline on open; 9 save cards on failing submit |
| adopt login popup | 10 / 10 | 8 / 6 | 8 / 6 | 2 / 4 | 0; no frame emptied |
| no login field | 10 / 10 | 10 / 10 | 10 / 10 | 0 / 0 | 0 |

Popup adoption/next succeeded in 0/2 vs 0/4 frame-drawn tries, and 8/8 vs 6/6 without a frame.

Main's two failed autofocus next calls were `target_closed` detaches while 1Password's inline frame loaded: logs cannot distinguish another frame from the same one finishing. Both later reads worked; no tab was lost.

Unlocked at each build's start and before tries 0 and 5 in every cell; other tries' starting lock state was not measured. Two later reads checked delayed/duplicate reports without repeating cells; no notice needed them.

The notice says "Nothing was saved", identifies the hidden frame and extension, and labels the title as the page's words, not Chrome's name for the extension.

- **Reporting only:** identity probes do not hold main's sweep or retry.
- **No new permission:** fetch each emptied URL from its own frame in the isolated world; report only exposed extension pages that load. Loaded URLs supply ids/paths; paths and titles are quoted and bounded.
- **Told once:** the driving worker consumes reports; a detached worker leaves them for its replacement.

## Why

The agent heard only "a password manager's inline autofill menu", and a hidden save card went unmentioned. The card cannot stay visible: with it in an attached tab Chrome refuses every debugger command.

Blind Claude Haiku 5.5 runs with a stand-in vault whose card page is titled `1Password`, measured on an earlier base with this same notice text:

| final message | without this PR | this PR |
|---|---|---|
| identifies the extension | 0/5 | 5/5 |
| says nothing was saved | 0/5 | 1/5 |
| claims a login was saved | 0/5 | 0/5 |

**Alternative:** `management` would supply Chrome's extension name, but adds the install warning "Manage your apps, extensions, and themes".

## Testing

`bun test packages/coding-agent/test/tools/browser-relay`, in order and with `--randomize` seeds 1 to 10: all pass. A stand-in save card is named once; uninstalled, unexposed, `/../` and relay-own pages are never named. Tests cover nonblocking probes, partial probe failure and replacement-worker delivery; extension installation is awaited.

Not covered: frames held for a tab nobody adopts again are told to the next omp that adopts it; a report that lands after the last call on a tab is never shown; the identity fetch runs in the driven tab, so it may appear in that tab's captured network requests.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
