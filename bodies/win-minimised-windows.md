## What

I made `apps.open` on Windows bring back an app whose windows are all minimized instead of launching it again, since minimizing made the app vanish from the computer tool.

`computer.windows()` on Windows leaves minimized windows out, so an app whose windows were all minimized had no window the model could find, and `computer.apps.open(app)`, which the `window()` miss error points to, ran the shell launch again and could start a second copy. Now it shows that app's frontmost minimized window again and returns it as `window`, as macOS `apps.open` already does for a running app with no window on screen.

| `apps.open` on Windows | `main` | this PR |
|---|---|---|
| app not running, or one of its windows listed | launches | same |
| running, every window minimized | launches again, `window: null` | shows the frontmost one again, returns it as `window` |
| same, `activate: true` | launches with activation | restores it as it was and asks for the foreground, as `raise()` does |
| a shortcut with arguments (`pythonw.exe script.pyw`, a browser profile) | launches | same: its executable's other windows are not its own |
| the window stays minimized (an elevated app) | | throws with the reason, nothing launched |

**Beyond the fix:** without `activate`, a window that was maximized comes back at its normal size. Windows has no show state that restores a maximized window without activating it, and activating would take the user's foreground, which the tool's background input avoids. Passing `activate: true` keeps it maximized.

## Why

I rejected listing minimized windows with a `minimized` flag: that changes `DesktopWindow` on every backend, and every caller that captures or sends input to a listed window would have to refuse minimized ones. macOS already leaves them out of `windows()` and brings the app back through `apps.open`; Windows now keeps that contract.

A window belongs to the app when its process has the key `apps.list()` matched the app by (image path, or AUMID when packaged); `running_processes` and the new check share that read (`ProcessKeys`), and "listed" is the filter `windows()` applies (`describe`). A window list that cannot be read launches, as on `main`.

Non-goals: an app with a listed window plus minimized ones still launches; UWP frames owned by ApplicationFrameHost are not matched and launch as before.

Review first: `restore_minimized` in `win32/capture.rs` and `process_key` / `open` in `win32/applications.rs`.

## Testing

- `cargo test -p pi-natives --lib win32::reopen` on Linux: 3 pass; with `reopen` reverted to always launch and the shortcut check to always match, the all-minimized and shortcut-arguments tests fail.
- `bun test test/tools/computer.test.ts`: 145 pass; the new Windows miss-hint case fails with the `worker.ts` route reverted.
- `cargo xwin clippy` for `x86_64-pc-windows-msvc`, Linux and macOS clippy, rustfmt: clean on the branch's lines.
- Live check on a Windows 11 guest, Notepad's only window (`notes.txt`) minimized, `computer.apps.open` with Notepad's exact app id (the bare name "Notepad" is ambiguous on Windows 11):

| | `main` | this PR |
|---|---|---|
| `apps.open(id)` | `window: null`; a second Notepad ("Untitled") opens, `notes.txt` stays minimized and unlisted | returns the `notes.txt` window, listed again, no second copy |
| then `apps.open(id, { activate: true })` | `window: null`; a third Notepad opens | returns the same window, now in front |

  The first restore after staging the desktop brought Notepad to the front in both runs, and so did one of two `ShowWindow(SW_SHOWNOACTIVATE)` calls made from a plain Python process with no omp involved; later non-activating restores through `apps.open` left the user's window in front 2 of 2 times.

---

- [ ] `bun check` passes
- [ ] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
