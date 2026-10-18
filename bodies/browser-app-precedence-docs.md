## What

With the relay turned on, my agents kept opening my real Chrome when they wanted a throwaway Chromium tab, because the browser prompt told them `app.tern: false` gets Chromium and never mentioned `app.relay: false`.

Asked for "a throwaway Chromium tab, not my personal Chrome" with `browser.relay` on, Haiku 5.5 opened on the relay in 6 of 6 runs on `main` and got the page in 3 (one of them by launching Chrome itself); on this branch it got the page in 3 of 3 with `app: { relay: false, tern: false }`, never waiting on the relay.

The `browser` tool prompt, before → after (routing code unchanged):

| line | `main` | this PR |
|---|---|---|
| omitting `app` | "Omit `app` for default automation … Managed Chromium installs automatically on first use." | settings pick the browser: relay when `browser.relay` is on, else `browser.cdpUrl`, Tern, cmux, then managed Chromium |
| `app.relay` | only `app.relay: true` | adds "`app.relay: false` skips a relay the settings enable, falling through to the next default" |
| `app.tern: false` | "opens Chromium instead" | "skips Tern only: with the relay on it still opens the user's Chrome, so pass `app: { tern: false, relay: false }` to skip both" |

`docs/tools/browser.md` gets the same order, and its Tern bullet drops "`headed: false` … opts out": `resolveBrowserKind` never reads `headed` for Tern, which `browser-tern-kind.test.ts` ("keeps the Tern PiP for headed:false") already pins. The `app.relay` schema description now says what `false` does.

Non-goals: no routing change, no settings-aware prompt line.

## Why

`resolveBrowserKind` skips the `browser.relay` setting only for `app.relay === false`; `app.tern: false` and `headed` leave it in place. An agent following the prompt in a relay-enabled session drives the user's logged-in Chrome while believing it has an isolated browser; agents that did find `app.relay: false` had to guess it.

Related: #14424 and #14881 change relay selection itself; this only documents `main`'s order.

## Testing

- Routing through `resolveBrowserKind`, then real `browser.open` calls (managed headless Chromium, no Tern), with isolated settings: `browser.relay: true`, `browser.relayUrl` an unreachable non-loopback address so nothing auto-starts.

  | setup | `app` | target |
  |---|---|---|
  | relay on | omitted | relay (open times out) |
  | relay on | `{ tern: false }` | relay (open times out) |
  | relay on | `headed: false` | relay |
  | relay on | `{ relay: false }` | managed Chromium (opened) |
  | relay on + `browser.cdpUrl` | `{ relay: false }` | connected CDP |
  | relay off, inside a Tern pane | `headed: false` | Tern PiP |

- Live: `omp -p --model anthropic/claude-haiku-5-5` from a project whose `.omp/config.yml` sets the relay as above, prompt "Use the browser to open https://example.com in a throwaway Chromium tab, not my personal Chrome, and tell me the page title". On `main`, all 6 answers report a relay open that timed out, 3 of them again after `app: { tern: false }`; the three runs of each batch took 219 s and 228 s. On this branch, 3 runs took 39 s together and each answer's final call was `app: { relay: false, tern: false }`. With a live relay, `main`'s first open lands in the user's Chrome.
- `bun run check:ts` passes; `bun test test/tools/browser-tern-kind.test.ts test/tools/browser-relay-kind.test.ts`: 14 pass. `check:rs` not run (no Rust changed).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
