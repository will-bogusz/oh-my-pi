## What

I had two clients on one relay tab (two omp sessions, or omp plus the long-lived registry connection), and when one switched auto-attach off on its page, the other lost its cross-site frame: its next call into that frame failed with `Target closed`.

Reproduced on `main` (`21f1188cf88`) with two puppeteer connections to the relay on one page that embeds a cross-site frame. Connection A sends page-scoped `Target.setAutoAttach {autoAttach: false}`. Connection B's `Runtime.evaluate` on the child frame then fails with `Target closed`, and B receives `Target.detachedFromTarget` for a session it never released. With this PR, B's frame keeps answering and B sees no detach.

## Why

Every client of a relay tab shares one Chrome debugger attachment, so auto-attach is a tab-wide switch in Chrome. The bridge forwarded each client's `Target.setAutoAttach` to Chrome as it came, so the last client to send one decided for every client.

- **Per-holder intent.** Each session records whether it wants auto-attach. An `autoAttach: false` while another connection still has it on is answered locally. Only the requesting connection forgets its children: it gets `Target.detachedFromTarget` for them, and Chrome keeps them for the others.
- **Last holder turns it off.** When the last armed session is released or its connection closes, the bridge sends `autoAttach: false` to Chrome, so a registry-held tab doesn't keep auto-attaching for nobody.
- **One transition at a time per tab.** Auto-attach changes go through the per-tab queue the tab-wide switches already use (`#serializeSwitches`), but stay out of the `{ enabled }` switch table, since auto-attach takes other parameters and owns child sessions. Overlapping requests then can't settle out of order, and a failed enable's rollback can't undo another holder's state. A queued request whose session was released meanwhile gets an `Unknown session id` error instead of no reply.

Child-session-scoped `Target.setAutoAttach` is unchanged: it is out of this page-scoped fix.

## Testing

- `browser-relay-tab-isolation.test.ts` (headless Chromium with the real extension): two connections on one framed page. A disables auto-attach; B's frame still answers `Runtime.evaluate` and B sees no detach. Fails on `main` with `Target closed`.
- `browser-relay-bridge.test.ts`:
  - Another holder stays armed when one connection closes.
  - An explicit detach of the last armed session sends `autoAttach: false` to Chrome.
  - A failed in-flight enable from one holder leaves Chrome disarmed.
  - A queued request on a released session gets an error reply.
- Five relay test files: 166 pass, 0 fail.

```sh
cd packages/coding-agent && bun test test/tools/browser-relay-bridge.test.ts test/tools/browser-relay-tab-isolation.test.ts
```

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
