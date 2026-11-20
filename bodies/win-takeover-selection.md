## What

After a Windows takeover handed my window back, the text I had typed in a WinForms box came back all selected, so my next key wiped it; now my caret goes back where I left it.

OMP preserves the user's empty selection only when the same field still has that caret immediately before OMP's hand-back and has its whole non-empty text selected afterward. Other final caret ranges and selections stand. Cursor and caret writes stop on user intervention, without skipping the inherited foreground cleanup.

## Why

A WinForms text box can select all on keyboard-style activation after its app sets the text. A mouse click back does not have that effect. OMP's foreground hand-back uses keyboard-style activation, so the user's next key could replace their text.

A focus handler that deliberately selects all is indistinguishable from the native focus behavior through these Win32 messages; that case also restores the saved caret. A selection the app made while unfocused is detected before hand-back and left alone.

The probe uses the dialog manager's `DLGC_HASSETSEL` capability check for windowed edit controls, not application-name detection. WPF and browser fields without that capability are outside this repair. Saving and each hand-back's paired checks use a 200 ms phase budget bounded by the call's deadline; hung fields and positions above 65,535 are left alone. Confirmed late-activation hand-backs use the same guarded repair.

Review `UserSelection::save` and `restore`, then their ordering in `ForegroundGuard`, in `win32/input.rs`.

Related: #16573 refuses background WinForms actions; this repairs the user's caret after a foreground takeover.

## Testing

At prior head f6e300389784 on Windows 11: `takeover_hands_back_the_users_caret_where_it_was` passed twice, interleaved with parent 866f44a24a7, which failed twice with the same fixture. The Win32 edit fixture covers select-all on focus, an intentional move to the end, selection changed while unfocused, and caret repair after late-activation recovery.

At that head, `rust-check` passed on Linux, macOS and the Windows MSVC target. The Windows unit runs predate build-hash attestation: hash not recorded. Live checks were not repeated after the C review-fix restack. The earlier framework-specific WinForms, WPF, Chrome and Notepad matrix was not rerun.
