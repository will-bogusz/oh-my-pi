## What

I fixed two omp processes mistaking each other's macOS clicks for the user's input and blocking the next call.

Two processes clicking the same app 1.5 seconds apart went from 10/10 false takeover refusals to 0/10. Only the intervention tap's classification changes; event posting and its five-second quiet window stay the same.

## Why

Making a window key emits untagged left-button records at `(0, 0)` under the posting process's PID. The other omp process counted those as the user's input. The tap now excludes that exact shape from a nonzero foreign PID. Hardware PID-zero clicks, dictation keys and other tools' real-coordinate clicks still count.

Review first: `control/macos.rs::foreign_input`. Another tool's untagged left click exactly at the origin has the same shape and is excluded too; hardware input there is still protected. No activation or raw-record format change is needed.

<details>
<summary>Shared hunks tested together</summary>

PR 16553 adds a button monitor and CGPoint import in the same control/macos.rs tap module; its original foreign predicate is preserved. Its skylight.rs make-key posting is untouched. PRs 17756 and 18824 change pointer posting in macos/input.rs, PR 17757 changes capture geometry, and macos-scroll-direction changes scrolling in that pointer path. Their combined tree passes 962 native tests, the capture-geometry test and a darwin addon build. Integration-only sibling scroll conflicts retain priming, current Quartz constructors and chunked scrolling.

</details>

## Testing

macOS 26.5.2 VM, two independent source-build AgentSessions through eval/computer/native workers, ten trials per row. Target apps logged actual delivered clicks in separate files.

| B's input 1.5 s after | Before refusals | Fixed refusals |
|---|---:|---:|
| A takeover, same app, background | 9/10 | 0/10 |
| A takeover, same app, takeover | 10/10 | 0/10 |
| A takeover, other app, either route | 0/10 each | 0/10 each |
| HID user click, same app, either route | not measured | 10/10 each |

All non-refused fixed clicks landed. An independent tap still saw 60 untagged make-key down/up pairs, so posting was preserved rather than suppressed.

The classification regression fails without the exclusion and passes with it: `cargo nextest run -p pi-natives --lib -E 'test(the_users_and_their_tools_input_is_foreign)'`. It checks origin records, hardware PID zero, real-coordinate foreign clicks and other event types. Standalone addon build and `scripts/rust-check` on macOS, Linux and Windows pass. Full `bun check` was not run for this macOS-only Rust change.

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
