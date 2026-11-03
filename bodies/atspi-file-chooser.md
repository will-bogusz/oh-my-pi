## What

gedit's Open dialog had no accessibility tree at all through the `computer` tool on Linux, because GTK3 gives file dialogs their own role instead of dialog, so I count that role as a window when the app itself owns it.

| gedit 46 (GTK 3.24), Open Files dialog | `main` | this PR |
|---|---|---|
| `picker.ax()` | `AxFailed: AT-SPI window root: window 'Open Files' has 0 matching AT-SPI frames` | 133-line tree |
| `ref.click()` on its Downloads place, then Cancel | unreachable: no refs | both land; Cancel closes the dialog |

> **AT-SPI context.** An app's direct children are its top-level windows. OMP only accepted those whose role is frame, dialog or window; GTK3's `GtkFileChooserDialog` reports `FILE_CHOOSER`, and so does the file chooser widget inside it.

## Why

- `FILE_CHOOSER` counts as a window only as a direct child of the application. Inside a window it stays a widget, so an element in the dialog resolves to the dialog rather than to its inner chooser widget (named "File Chooser Widget", which matches no X window), and an app that embeds a chooser widget keeps its own frame as the owner. Frame, dialog and window keep counting wherever they are, as on `main`.
- Being windows now, the dialogs also take part where windows do: Wayland window lists include them, and `computer.elementAt()` over a dialog that overlaps another window refuses as ambiguous, as it does for any two overlapping windows.
- The window list and the element-to-window walk moved into `AtSpiAx::top_levels` and `AtSpiAx::top_level` so they can be tested without a session bus; both behave as before for every other role.

Not covered: GTK3 message dialogs (role `ALERT`). Their accessible name is the message type ("Question") while the X window title is empty or the app's title, so they fail the title match before their role matters; that needs a different way to pair frames with windows.

## Testing

`file_dialogs_are_top_levels_only_under_the_application` lists the windows of a fake app holding a gedit-style Open dialog and a frame that embeds a chooser widget, and walks up from elements in both, over peer-to-peer D-Bus. With the role change reverted, the list misses the dialog and both dialog lookups fail; with the role counted anywhere, the lookups return the inner widget and the embedded one.

Live on Ubuntu 24.04 (Xorg, openbox) with gedit 46.2 through the `DesktopSession` calls the `computer` tool makes: the table above, with `takeover: true` clicks. Not run: Wayland.

`cargo test -p pi-natives --lib -- desktop::linux::ax`

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
