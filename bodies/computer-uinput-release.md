## What

I made the X11 virtual keyboard and pointer always send a release, so a shortcut or click stopped right after its last key or button went down reports success instead of `Cancelled`.

#16202 made computer use treat input as sent once its last press is out. On X11 with the MPX route, the releases after that press go through `UInputDevice::key` and `::button`, which checked the cancel token before every event. A stop landing in that gap made the release call fail, so the chord or click reported `Cancelled` even though the target saw a full press (Codex finding on #16202).

## Why

`key` and `button` now check the token only before a press. A release always goes out, and a cancel still stops the next press. Every caller already releases held keys and buttons under cleanup, so nothing else changes.

## Testing

`desktop::linux::x11::uinput::tests::a_cancel_stops_presses_but_never_releases` drives a device backed by `/dev/null` under a cancelled token. On `main` plus only the test, the key release returns `Cancelled`. With the fix, presses still fail and releases go out. `cargo test -p pi-natives --lib desktop::` on Linux: 190 of 190 pass. `cargo fmt --check` is clean, and clippy reports nothing in the changed file.

Not run: a live X11 MPX session; the test covers the device call, not a full chord through the X server.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
