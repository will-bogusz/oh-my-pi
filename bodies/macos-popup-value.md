## What

I made `setValue` on a `<select>` in Chrome or an Electron app on macOS match Chromium's untitled options by the text they report as their value, open the menu to find them, and close that menu the way omp already closes the menus a click opens. Before, it refused every option with an empty option list.

In a Chrome and an Electron window behind the user's, `setValue("Medium")` on a `<select>` went from refused 40 of 40 to chosen 49 of 50, with the page's `change` handler running exactly once each time and no menu left open when the call returns.

## Why

A closed Chromium `<select>` shows accessibility one child, its chosen option, with an empty title and the option's text as its value. `setValue` matched options by title only and opened the menu only when the popup showed none, so it refused with `Options:` followed by nothing. When the closed select showed no child at all, `main` opened the menu, found nothing titled, and left it open behind the user's app, where it kept their keystrokes. Chromium's open menu lists options the same way, ignores `AXCancel`, and after a press shows the menu again in a new window 20-40 ms later, which stays open until Escape. So:

- An option's name is its title, or its value when it has no title; a titled native option reads exactly as on `main`.
- The menu is opened whenever the popup does not already list the requested option and no menu is open. If it will not open, the refusal lists what the closed popup published.
- The menu `setValue` opened is closed by the routine that closes a menu a background click opened, which now watches every menu window the call opened, so a menu shown again in a new window gets Escape at once; one that fades out gets none.
- That routine posts Escape only when the app's menu window is in a window list read right before it. A menu that closed meanwhile, or an unreadable list, gets no Escape, since a stray Escape cancels a dialog or a form. A menu still open after all this fails the call.

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

Limits:
- The one miss was a Chrome menu whose items never appeared in the accessibility tree within a second: the call refused with the option the closed select showed, closed the menu, and the user's keys went to the menu for about 1.2 s that time.
- A Chromium choice takes 0.87 s against `main`'s 0.53 s refusal: the menu has to open, and its re-shown window takes about 250 ms to fade after Escape.
- Every background pop-up choice still makes the target window key for about 25 ms and raises it, as on `main`.
- The item lists in click and key-press refusals still leave out a Chromium `<select>`'s options, which have no title.
- Not tried: a `<select>` in WebKit (Safari, a `WKWebView`).

<details><summary>Unit tests and what was not run</summary>

`cargo test -p pi-natives --lib -- popup open_menu`: 37 pass. New tests cover untitled options matched by value, when the menu is opened and counts as built, a refusal that keeps the published options, a pressed native menu that fades out with no Escape, a menu shown again in a new window that is closed by Escape without waiting out the fade, a menu that closed before the Escape and an unreadable window list (no Escape in either, which `main` sent), and a cancelled call that still closes its menu. clippy and rustfmt on macOS and Linux. With the separate window-order fix applied, the raise showed in one 50 ms sample of the benchmark's checker in 4, 6 and 2 of 10 AppKit, SwiftUI and benchmark-app trials. Not run: the guidance was not changed, and no model was run.

</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
