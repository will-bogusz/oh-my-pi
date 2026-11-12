## What

A relay tab omp drives no longer gets closed when a password manager's frame opens in it while omp is attached. After Chrome drops omp from such a tab (`target_closed`), the relay extension empties and hides the other extensions' frames there and takes focus off the element focused beside them, sweeping again while a pass still finds one (at most four passes, 350 ms of waits); the next attach on that tab waits for the sweep, at most one second. Tabs omp does not drive, and detaches the relay asked for or the user cancelled, are left alone.

## Why

#16908 empties a foreign frame only when Chrome refuses an attach. Chrome also accepts a reattach while that frame is still loading, then drops omp again 6 to 10 ms later; after two such drops omp gives up and closes the tab. Re-adopting focuses the page again, so a vendor that opens its menu on focus reopens it every time. Blurring the field is what breaks that loop.

| 10 tries per case, stand-in vendor | `main` | this PR |
|---|---|---|
| login page, field focused on load: tab kept | 4/10 | 10/10 |
| vendor rebuilds its frame on every focus: tab kept | 0/10 | 10/10 |
| fill, submit, save card: tab kept | 5/10 | 10/10 |
| no password manager: per-call median | 3.4 ms | 2.0 ms |

The call during which the frame opens still fails (the submit, 0/10 on both); the tab survives it. Adopting a popup the page opened is unchanged (7/10 on both): the pick attaches before omp claims the tab, so nothing is swept there.

Real extensions installed from the Web Store, signed out (1Password 8.12.44.33, Dashlane 6.2646.1): tabs kept 10/10 on both `main` and this PR in every case. Signed out, 1Password drew a frame after the submit in 4 to 7 runs of 10, and neither vendor drew one on focus. The signed-in failure is not reproduced here.

**Behaviour change for the agent:** after a drop, the focused field loses focus. The reattach message now says so ("focus a field again before typing into it").

## Testing

`bun test packages/coding-agent/test/tools/browser-relay-tab-isolation.test.ts -t "password manager"`: a field focused on load, a save card after submit, and the user's own tab (menu and focus kept). It fails on `main`'s extension. `browser-relay-foreign-frames.test.ts` covers the repeat passes and the one-second bound. With the bound removed, it hangs while the page holds an `alert()`.

Not run: branded Chrome, a signed-in password manager.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
