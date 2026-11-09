## What

I had two clients on one relay tab (two omp sessions, or omp plus the long-lived registry connection), and when one switched auto-attach off on its page, the other lost its cross-site frame: its next call into that frame failed with `Target closed`.

Reproduced on `main` (`21f1188cf88`) with two puppeteer connections to the relay on one page that embeds a cross-site frame. Connection A sends page-scoped `Target.setAutoAttach {autoAttach: false}`. Connection B's `Runtime.evaluate` on the child frame then fails with `Target closed`, and B receives `Target.detachedFromTarget` for a session it never released. With this PR, B's frame keeps answering and B sees no detach.

## Why

Every client of a relay tab shares one Chrome debugger attachment, so auto-attach is a tab-wide switch in Chrome. The bridge forwarded each client's `Target.setAutoAttach` to Chrome as it came, so the last client to send one decided for every client.

- **Per-holder intent.** A session switching auto-attach off gets local child detaches while Chrome keeps the children attached for other holders.
- **Last holder turns it off.** Releasing the final armed session sends one disable per tab, including when a pending disable fails after its holder departs.
- **Serialized transitions.** Auto-attach reuses `#serializeSwitches` but stays outside the `{ enabled }` table because its parameters and child-session ownership differ.

Child-session-scoped auto-attach is unchanged. Cleanup is best-effort: retrying a failed last-holder disarm after an extension reconnect would require new retry state and reconciliation, outside this page-scoped isolation fix.

## Testing

- Real headless Chromium with the extension: after A disables auto-attach, B's cross-site frame still answers and sees no detach; this fails on `main` with `Target closed`.
- Focused suite: 127 pass, 0 fail. New failed-disable/departure cases fail without the rollback cleanup; the multi-session disconnect case fails without per-tab disarm deduplication.
- Coding-agent typecheck and `oxfmt --check` on all four changed files pass.
- Full `bun check` was not run: it includes Rust checks; this PR changes no Rust.

```sh
cd packages/coding-agent
bun test test/tools/browser-relay-bridge.test.ts test/tools/browser-relay-tab-isolation.test.ts test/eval/process-entry-import.test.ts test/cli-computer-lazy.test.ts
```

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
