## What

When I opened an HTML file or a URL in a browser with `computer.apps.open`, the agent got `window: null` for the file, or for the URL a window still titled with the tab it had before, and went looking for the window again; now it gets the browser window once it shows the page.

In a macOS 26.5 VM, an HTML file with its own `<title>` opened in Safari or Chrome came back `null` after 3.1-3.3 s on `main` in 3 of 3 cases, and as the page's window, titled with the page, in 1.0-1.3 s with this PR. A URL came back titled with the page in 1 of 10 cases on `main` and 7 of 10 with it.

| Opened item | `main` | this PR |
|---|---|---|
| HTML file with a `<title>`, browser running or not | `null` after 3.1-3.3 s | its window, titled with the page, 1.0-1.3 s |
| URL in a running browser | the right window at once, titled with the previous tab, "Untitled" or "New Tab" | the same window, titled with the page, about 1 s |
| URL of a page that takes longer than about 1 s, or that has the previous tab's title | the window at once, stale title | the window, "Untitled" or that title, at about 1 s or 3 s |
| TextEdit document; Finder reveal | the window titled with the file or folder | unchanged |

**Cost, and the choice it makes:** a URL open now takes about 1 s instead of 0.2 s, the whole 3.1 s when the page keeps the previous tab's title, and a page slower than about 1 s still comes back "Untitled". In return the window carries the page's title in 7 of 10 URL opens instead of 1. Dropping the URL wait would keep 0.2 s and the file fix but return `main`'s stale title; I kept it because the agent then goes looking for the window again.

## Why

A browser shows an opened URL or file in a tab of a window it already has, and titles that window with the page's `<title>` once the page loads. `main` looked for a window titled with the file's name, which a titled page never has (`null` after the whole 3 s wait), and for a URL returned the frontmost window at once, before the tab had switched. In four of five real sessions, `apps.open` on a page came back like that: two HTML files `null`, a `chrome://extensions` call titled with a Gmail tab.

With this PR the name match still comes first. Otherwise `apps.open` takes the first window, front to back, whose title changed since the call (for a URL, also one that opened since), once that title has stayed the same for about 0.7 s: Safari shows a new tab as "Untitled" for 0.1-0.4 s before a local page's title. The wait keeps `main`'s 3 s bound. A file whose window never changed returns `null` as before; an Open panel a document app shows first never counts, since a new window counts only once its title changes. Files also match the name Finder shows, so Pages' `Budget.pages`, titled "Budget", is found at once.

Rejected: reading the page's URL from accessibility (Chrome's window reports `AXDocument`, Safari's does not).

## Testing

- `shown_window` unit tests in `crates/pi-natives/src/desktop/macos/applications.rs`, on injected window lists: a file titled by its page in an existing or new browser window, Safari's interim "Untitled", the front window first, a URL's new window, the Finder display name, an Open panel at the deadline, unreadable titles. With `main`'s choice of window put back into `shown_window`, 2 of them fail. `cargo test -p pi-natives --lib desktop::applications` on macOS: 25 passed.
- Live, a lume macOS 26.5 VM with Safari, Chrome and TextEdit, `main` against this branch on the same 18 cases, from a closed browser to a page that takes 1.5 s and a TextEdit document.
- `rust-check` on macOS and Linux.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
