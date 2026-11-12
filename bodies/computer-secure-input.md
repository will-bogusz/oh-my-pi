## What

I made the computer tool say when macOS secure input is on, because that's exactly when the user's Escape and typing stop reaching it.

While a password field has the keyboard, macOS hides every key from event taps, so the user's physical Escape no longer stops takeover input and their typing no longer stops a call with `UserIntervened`, while `capabilities()` kept reporting `globalEscape: true`. Measured in a macOS 26.5 VM (10 tries each):

| focused field | Escape stops a takeover `holdKeys` | typing raises `UserIntervened` | `globalEscape` on main | after this PR |
|---|---|---|---|---|
| plain text field | 10/10 | 10/10 | `true` | `true`, no note |
| secure text field (AppKit) | 0/10 | 0/10 | `true` | `false`, `secureInput: true`, `secureInputApp: "Fixture"`, run note |
| SecurityAgent admin prompt | 0/10 | 0/10 | `true` | `false`, `secureInputApp: "SecurityAgent"`, run note |

`capabilities()` and the `screenState` getter now report `secureInput` and the holding app (`secureInputApp`, from the session's `kCGSSessionSecureInputPID`), `globalEscape` is false while it holds, and a run that ends with it on starts with a `Note:` naming the holder. What input is sent does not change. Off macOS both fields read `false`/unset.

## Why

The Escape stop is the user's way out of takeover input, and the agent is told it exists through `globalEscape`. A focused password field, an authentication dialog or a terminal's secure keyboard entry silently switches it off; on the SecurityAgent prompt the user's Escape cancelled the prompt 10/10 times while omp's held input kept running for its full duration. Telling the agent lets it avoid relying on a stop the user cannot give.

## Testing

- macOS VM (bench clone, macOS 26.5.2), keys sent through the VM's VNC server so the guest sees hardware input: the table above, on `main` and on this branch.
- `bun test test/tools/computer.test.ts`: the new test fails with `protocol.ts` reverted (no note) and passes with it; it also checks the note stays out while the screen is locked, where the lock note already says keys fail.
- `cargo test -p pi-natives --lib`: `secure_input_turns_the_escape_stop_off` and the existing capture lock/sleep tests pass; `rust-check` on macOS, Linux and Windows.

Like the lock note, the secure-input note comes with each `computer` call, so an Eval cell that makes three calls while it holds shows it three times.

---

- [ ] `bun check` passes (type check fails only in `test/cursor-todo-persistence.test.ts`, untouched here and failing the same on `main`)
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
