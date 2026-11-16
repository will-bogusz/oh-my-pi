## What

I wanted the browser tool to tell the agent when its click opened something on screen the page can't answer, like a `<select>` menu, a colour picker or a passkey sheet, and hand it that window for the computer tool.

Visible managed/spawned browsers and a loopback relay on macOS name new native windows over the tab with their `computer.window(id)` handle, but only while the browser's own tab list shows that tab in front of its window. Windows appearing within 2 s after a call return are named by the next call. Failed calls carry notices, except timed-out or cancelled calls, which skip sampling to preserve the existing cleanup grace. Headless browsers, connected CDP endpoints and remote relays are excluded.

| Pre-review visible Chrome checks; 5 managed + 5 relay per arm | On screen | Named before | Named here, correct handle |
|---|---|---|---|
| `<select>`, colour input, date picker | 30/30 | 0/30 | 30/30 |
| notification/geolocation permission | 16/20; prompts stopped appearing on the fifth attempt | 0/16 | 16/16 |
| passkey | 10/10 | 0/10 | 10/10 |
| plain button, `fill` | nothing | 0/20 | 0/20 |
| `confirm()` | 10/10 | 0/10 | 0/10; left to `tab.dialog()` |
| another app's window over the tab | 100/100 | 0/100 | 0/100 |

## Why

These windows can appear while the browser call reports success. The page cannot say whether its tab is in front: omp focus-emulates every tab it drives, so a background page's `document.visibilityState` stays "visible", and reading it named the user's own `<select>` menu in the front tab to the agent in every try below where the agent's tab had been shown. The browser's tab list says it instead: the relay extension's active flag, or the order of Chrome's `/json/list`. Managed browser handles now carry Chrome's pid, so their window match is limited to Chrome's process.

<details>
<summary>How the window and the front tab are found</summary>

Matching the tab's isolated-world frame against the window roster adds a notice without answering the window; ambiguous ownership and page-backed popups are suppressed.

The relay's `/json/list` marks the extension's active tab. Chrome's own list orders pages by when each was last shown (`DevToolsHttpHandler::RespondToJsonList` sorts on `WebContents::GetLastActiveTimeTicks()`) and a never-shown page by its creation, so a tab counts as in front only while no page of its window is listed before it and, unless it is alone there, it is known to have been shown:

- omp opened it in front;
- its page reports the place of one browser window off the screen origin, which a page learns only while shown (`RenderWidgetHostImpl::SendScreenRects` skips hidden widgets);
- or a read saw it overtake a tab of its window.

The list read takes 0.2–0.4 ms after the frame read.

</details>

## Testing

`bun test packages/coding-agent/test/tools/browser-native-windows.test.ts packages/coding-agent/test/tools/browser-profile-cleanup.test.ts`: 60 pass in the macOS VM, 57 pass and 3 macOS-only skips on Linux; 13 fail with the old answer and without the pid. Neighbouring browser suites: 347 pass.

In a macOS 26.5 VM with Chrome for Testing 150, the agent's tab sat behind the user's tab in the same window, and the user's clicks were real input over VNC:

| The user opens a `<select>` in the front tab | Before | After |
|---|---|---|
| managed browser, during an agent call | 21/21 named | 0/10 |
| managed, during a call that clicks into the agent's tab | 10/10 | 0/10 |
| managed, 0.3 s after a call returns | 20/20 | 0/10 |
| managed, agent's tab shown and then hidden | 3/3 | 0/10 |
| relay tab, during a call / one that clicks into it / after it | 10/10 each | 0/10 each |
| relay, agent's tab never shown since it opened | 0/35 | 0/10 |
| spawned Chromium, during a call / after it | not measured | 0/10 / 0/10 |
| headless agent beside the user's Chrome | not measured | 0/10 |
| control: the agent's own tab in front opens its menu | 10/10 named | managed 10/10, relay 10/10, spawned 10/10 after the user shows its tab once; 0/3 while a tab opened behind it ranks first |

Chrome 157 on Linux orders the list the same way (30 of 30 tries per browser kind).

## Limits

| Limit | What happens |
|---|---|
| Linux and Windows; answering the window | not supported |
| the tab list cannot be read | nothing is named |
| a tab opened in the background of the agent's window | it ranks first until a tab there is shown, so the agent's own windows go unnamed meanwhile |
| a spawned Chromium, which opens the agent's tab in the background | its windows are named once the user has shown that tab; in a window at the screen origin, only after one call has seen another tab of the window in front and a later call the agent's tab again |
| the agent's own `<select>` menu, which often shows after its call has returned (about 30 ms after the click in a managed browser) | the next call names it |
| an unreadable page-frame probe | ordinary-window notices are suppressed |
| tooltips, autofill and save-password surfaces | can be wrongly named as a select menu or picker, because the roster has no native roles |
| restarting the 4,096-id seen set | an old window can be wrongly reported as new |
| user activity in the watched tab; `print()` | untested |
| a tab change while the window is fully covered or minimised; Chrome's split view | unmeasured: Chrome may not move a tab up its list there |

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with attribution

