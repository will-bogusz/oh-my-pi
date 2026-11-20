## What

I kept hitting GTK message boxes the `computer` tool simply couldn't see on Wayland, so an agent that opened an OK/Cancel prompt had no way to answer it; this lists them as windows the same way the GTK file dialogs already are.

On Omarchy (Hyprland) and GNOME, a GTK 3 message dialog goes from **0/10 → 10/10** listed by `computer.windows()`, and its OK button found and pressed through accessibility from 0/10 → 10/10.

| Desktop (n=10 each) | `main` | this PR |
|---|---|---|
| Omarchy 4.5, Hyprland 0.56.2 | not listed; `computer.window({ title })` throws "no window matches" | listed; OK found, pressed, dialog answered "ok" |
| GNOME Shell 50.6, Fedora 44 | same | same |

> **AT-SPI context.** On Wayland, OMP lists windows from the accessibility tree: the application's children with role `Frame`, `Dialog` or `Window`, plus `FileChooser`, which GTK 3 gives its Open and Save dialogs (#18011). GTK 3 gives `GtkMessageDialog` the role `Alert`, so on `main` it is never a window: not listed, no `ax()`, its buttons unreachable.

## Why

- **Only as a direct child of the application**, the rule `FileChooser` already follows. `Alert` is also the role of banners and toasts inside a window (libadwaita's toast); those stay part of their window.
- **X11 matching refuses a title two windows share.** On X11, an AT-SPI window is matched to its X window by process and title. An untitled GTK 3 message dialog is named after its kind over AT-SPI ("Question") while X titles it with the program name, so a main window titled "Question" would have taken the dialog's input. `window_id` now refuses while another top-level window of the app has the same title, as it already refused two X windows with one title. Rejected: matching by geometry, a larger change to X11 matching for every window.
- **Maintenance.** This rests on GTK 3 giving message dialogs the `Alert` role, as it has since 3.0; GTK 4's is a `Dialog` and was already listed.

Non-goals: how a button is pressed (unchanged), X11 listing (X already lists the dialog), Qt and LibreOffice message boxes (not measured).

## Testing

- `cargo test -p omp-natives --lib desktop::linux::ax` on Linux: 47 passed. `a_message_dialog_is_listed_and_never_given_another_window_of_its_title` runs `windows()` and `window_id` on a fake GTK 3 app; it fails with the `Alert` arm reverted (`["TDLG"]` instead of `["TDLG", "Question"]`) and with the shared-title check removed. It also pins that a button in an in-window alert belongs to its window.
- Live, on this head and on `main` with the same JS tree and only the addon swapped, builds alternating per trial: a GTK 3 app opens an OK/Cancel `Gtk.MessageDialog` through a control file; one `computer` cell runs `windows()`, opens the dialog's window, `find({ title: "OK" })` and presses it; the app records the response. Every trial alike, as in the table.
- Not run: X11 live (the test covers the guard), KDE.
- `rust-check` on Linux and Windows.
