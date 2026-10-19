## What

With the browser relay turned on, my agents kept opening pages in my real signed-in Chrome when the task wanted a throwaway browser, because nothing they read said the relay setting had changed the default.

Asked for "a throwaway Chromium tab, not my personal Chrome" with `browser.relay` on, Haiku 5.5's first `browser.open` went to the relay in 6 of 6 runs on `main` and 0 of 6 with this PR; asked to use "my Chrome (where I'm signed in)", it still went to the relay 6 of 6.

While an open without `app` resolves to the relay (`browser.relay` on, or `PI_BROWSER_RELAY=1`), the browser prelude adds this system-prompt block, the way the computer prelude adds its own:

> # Browser Relay
>
> The browser relay is on: `browser.open` without `app` drives the user's own Chrome, signed in as them. Pass `app: { relay: false }` for a throwaway managed browser.

With `browser.cdpUrl` also set, the last sentence reads "Pass `app: { relay: false }` to open in the browser at `browser.cdpUrl` (<url>) instead.", which is where `resolveBrowserKind` sends it. Without the relay nothing is added.

Non-goals: no routing change; no block for `browser.cdpUrl` alone, which an open has no way to skip.

## Why

The `browser` prompt is static: it says omitting `app` gives managed Chromium and `app.tern: false` opens Chromium, while `resolveBrowserKind` puts the relay ahead of both unless `app.relay === false`. In our own sessions 6 `tern: false` opens landed on the relay and 27 calls used the undocumented `relay: false`.

The prelude's `guidance` is the settings-aware place: its own system-prompt block, replayed by the prelude notice when eval is enabled mid-session. It reads the same setting and env override as `resolveBrowserKind`, once, when the prelude is created. Flipping `browser.relay` mid-session changes routing but not the block: turned on, the session has no block (as on `main`); turned off, a stale `relay: false` is a no-op. Updating it live would need the prelude notice to track guidance text, not just prelude names: a separate change.

Related: #16294 documents the same order in the static prompt and docs and touches neither file here; on its own it moved the first open off the relay in 2 of 6 runs.

## Testing

- `test/tools/browser-relay-kind.test.ts`: the block is present exactly when `resolveBrowserKind({ action: "open" })` gives the relay, across `browser.relay` × `PI_BROWSER_RELAY`, and names `browser.cdpUrl` when set. With `prelude-definition.ts` from `main` both cases fail; 8 pass.
- Live: `omp -p --model anthropic/claude-haiku-5-5 --thinking low`, project config with `browser.relay: true` and an unreachable `browser.relayUrl` (nothing reaches a real Chrome), isolated agent dir, 6 runs per cell:

  | task | first open on relay, `main` → PR | mean wall, `main` → PR |
  |---|---|---|
  | "throwaway Chromium tab, not my personal Chrome" | 6/6 → 0/6 | 62 s → 11 s |
  | "my Chrome (where I'm signed in)" | 6/6 → 6/6 | 72 s → 86 s |
  | "check my dev server renders" | 6/6 → 3/6 | 85 s → 23 s |

  On `main` each throwaway run hit one or two 30 s relay timeouts first; 5 of 6 then guessed `relay: false`, one launched Chrome by `app.path`. With this PR all 6 opened with `app: { relay: false }` first.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
