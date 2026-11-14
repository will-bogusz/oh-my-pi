## What

I made `setValue` on a `<select>` in Chrome or an Electron app on macOS match Chromium's untitled options by the text they report as their value, open the menu to find them, and close that menu the way omp already closes the menus a click opens. Before, it refused every option with an empty option list.

In Chrome and Electron windows behind the user's, `setValue("Medium")` on a `<select>` went from refused 40 of 40 to chosen 49 of 50, the page's `change` handler running once each time and no menu left open at return.

## Why

A closed Chromium `<select>` shows one child, its chosen option, with an empty title and the option's text as its value. `setValue` matched options by title only and opened the menu only when the popup showed none, so it refused with `Options:` followed by nothing. When the closed select showed no child at all, `main` opened the menu, found nothing titled, and left it open behind the user's app, where it kept their keystrokes. Chromium's open menu lists options the same way, ignores `AXCancel`, and after a press shows the menu again in a new window 20-40 ms later, which stays open until Escape. So:

- An option's name is its title, or its value when untitled; a titled native option reads exactly as on `main`.
- The menu is opened whenever the popup does not already list the requested option and no menu is open. If it will not open, the refusal lists what the closed popup published.
- The menu `setValue` opened is closed by the routine that closes a menu a background click opened, now watching every menu window the call opened: a menu shown again in a new window gets Escape at once, one that fades out none.
- That routine posts Escape only when the app's menu window is in a window list read right before it. A menu that closed meanwhile, or an unreadable list, gets no Escape, as a stray Escape cancels a dialog or form. A menu still open after all this fails the call.

AppKit and SwiftUI pop-ups publish no options while closed and close on `AXCancel`; their path is `main`'s.

## Testing

Each row is a macOS VM, the select's window behind one where a simulated user types; "page keys" are key events the page received. `main` and this PR ran interleaved.

| Control | `main` | This PR |
|---|---|---|
| `<select>` in Chrome and Electron, 4 controls | refused, 40 of 40 (0.53 s) | chosen 39 of 40, handler once each, menu closed at return 40 of 40, page keys 0 (0.87 s) |
| `<select>` that closes its own menu on change | menu left open after an empty refusal, 3 of 3 | chosen 10 of 10, menu closed at return 10 of 10, page keys 0 |
| AppKit pop-up | chosen 3 of 3 (0.57 s) | chosen 10 of 10 (0.59 s) |
| SwiftUI picker | chosen 10 of 10 (earlier run, same VM) | chosen 10 of 10 (0.58 s) |
| An option that does not exist | Chrome: refused with an empty list; AppKit: refused with the list | Chrome and AppKit: refused with the full list, menu closed, 6 of 6 |

Second push: after `AXCancel`, only a menu that neither posts `AXMenuClosed` nor leaves the window list within 300 ms gets Escape (why not a fixed wait: details). macOS VM, typist on, `3d5659945b2` against it:

| Case | Before | After |
|---|---|---|
| `AXMenuClosed` naming the cancelled menu (AppKit, SwiftUI, context, menu bar) | | 40 of 40, 2-9 ms after the cancel, before the window leaves the list |
| Native menu, nothing chosen, 4 kinds | | Escape reaching the app 0 of 160 under CPU load, 0 of 80 idle; refused with items, menu closed 240 of 240 |
| Chrome, option not present, 40 tries | menu up ~850 ms, call 1.40 s | refused 40 of 40, menu open at return 0, menu up 547 ms (p95 584), call 1.11 s, page keys 0, typist keys lost 0 of 45 |
| `setValue("Medium")`, Chrome and Electron (5 controls) and AppKit, SwiftUI, 10 tries each | applied 70 of 70, 0.85-0.87 s web, 0.58 s native | applied 70 of 70, 0.86-0.88 s web, 0.58 s native |

Limits:
- Asking for an option a Chromium pop-up lacks holds its menu, and the user's keys, for 547 ms (median; about 850 ms before the second push): Chromium ignores `AXCancel`, so Escape follows the 300 ms watch.
- A Chromium choice takes 0.87 s against `main`'s 0.53 s refusal: the menu has to open, and its re-shown window fades for ~250 ms after Escape.
- Every background pop-up choice still keys the target window for ~25 ms and raises it, as on `main`.
- Not tried: a `<select>` in WebKit (Safari, a `WKWebView`), and a menu in an Open or Save panel.

<details><summary>Unit tests and what was not run</summary>

The one miss in the first table: a Chrome menu's items never appeared in the accessibility tree within a second; the call refused with the closed select's option, closed the menu, and the user's keys went to it for about 1.2 s.

Why not a fixed wait: native menus stay listed 11-22 ms (p95) after an `AXCancel` that returns Ok, and up to 177 ms under CPU load; an Escape sent while one is still listed reached the app 80 of 80. If the observer cannot be set up, the close keeps the 600 ms wait before Escape.

`cargo test -p pi-natives --lib -- popup open_menu`: 41 pass; with the close reverted to the fixed wait, 4 of the new tests fail. New tests cover untitled options matched by value, when the menu is opened and counts as built, a refusal that keeps the published options, a pressed native menu that fades out with no Escape, a menu shown again in a new window that is closed by Escape without waiting out the fade, a menu that closed before the Escape and an unreadable window list (no Escape in either, which `main` sent), and a cancelled call that still closes its menu. clippy and rustfmt on macOS and Linux. With the separate window-order fix applied, the raise showed in one 50 ms sample of the benchmark's checker in 4, 6 and 2 of 10 AppKit, SwiftUI and benchmark-app trials. Not run: the guidance was not changed, and no model was run.

</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)


