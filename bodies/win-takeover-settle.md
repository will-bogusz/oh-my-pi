## What

When a Windows takeover targeted an app that was busy, the call failed but the app jumped in front of me a moment later and took my keyboard; now OMP takes that late activation back, gives my window the foreground again, and the error says what happened.

A busy app can accept activation before its thread processes it. On an interrupted or timed-out activation, OMP lets that thread process its messages within the call's deadline and takes back a late activation only if no user input intervened. The error distinguishes a confirmed hand-back from an activation that may still arrive later.

## Why

- Both possible hand-backs require an observed target (or its owned window), an unchanged last-input record and a successful activity check. A different window or an unknown foreground transition never authorizes restoration.
- Intervention vetoes restoration, not the bounded message fence: a pending activation still gets its turn before the call returns. An activation call that Windows did not confirm is fenced but never authorizes a hand-back.
- `raise()` also distinguishes an accepted-but-pending activation from a refused request. The ordinary successful takeover path is unchanged.

Review `ForegroundGuard::activate` and `take_back_owed_activation` in `win32/input.rs`, then `window::activate` in `win32/window.rs`.

## Testing

Windows 11, head 866f44a24a7: `a_takeover_whose_target_comes_forward_too_late_leaves_the_users_window_in_front` passed twice, interleaved with the same test on parent f6a4155c9d6, which failed twice. The parent control adds only the regression fixture; its production code is unchanged.

`rust-check` passed on Linux, macOS and the Windows MSVC target. These Windows unit runs predate the harness's build-hash attestation: hash not recorded.

Interleaved WPF click/type calls with `takeover: true` (40 per build: 20 idle, 20 typing) returned success 34/40 on parent f6a4155c9d6 and 32/40 here; the other calls returned activation errors. Both kept all the user's typed text. The fixture confirmed all 34 parent successes and 31 of this head's 32 successes; one reported-success type call's target effect is unverified because the fixture's liveness oracle failed.

Those calls used TypeScript ref f6a4155c9d6 with each head's own native addon. Round two attested both installed native DLL hashes; round one predates that check (hash not recorded). This is not an unconditional success-rate or zero-key-event claim.
