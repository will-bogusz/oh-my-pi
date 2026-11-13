## What

I made omp keep a relay tab that a password manager's menu locks it out of, instead of closing it, because closing it took away the user's own tab and anything they were typing in it.

On real Bitwarden, when the agent's next call comes 300 ms after it clicks a login field, the tab was closed 10 of 10 times on `main` and is kept 10 of 10 with this PR. When Chrome refuses omp's reattach because another extension's frame is in the tab, omp now keeps the tab as it is, fails that one call saying what holds it, and the next call reattaches.

| Real Bitwarden, signed in, tab shown | `main`: tab kept | PR: tab kept | PR: first call answered | PR: the call after it | PR: tab drivable again |
|---|---|---|---|---|---|
| Agent clicks the login field, next call 300 ms later | 0/10, closed 1.6–1.7 s after the first refusal | 10/10 | 4/10 | 6/6, in 0.43 s | median 2.2 s after the click |
| Same, vault locked | 2/10 | 10/10 | 6/10 | 4/4 | median 1.2 s |
| A person clicks the field and types while omp is attached (5 tries) | 0/5, closed 4.1 s after the first refusal | 5/5, their text intact 5/5 | 3/5 | 2/2 | |
| Next call 1.5 s after the click | 10/10, next call median 0.91 s | 10/10 | 10/10, median 1.22 s | | |
| The page focuses its field on load (5 tries) | 5/5, median 0.42 s | 5/5 | 5/5, median 1.22 s | | |

The failing call says the tab is still open, what holds it and that calling again works (texts below).

## Why

Chrome refuses an extension's debugger for the whole tab while another extension's frame is in it. The relay empties such frames and retries, which is enough for 1Password, but Bitwarden's menu undoes the emptying, so Chrome keeps refusing until Bitwarden gives up after about ten such changes. A refused re-adoption then ran the worker-recovery kill, which closes a tab omp opened, so a call landing in that window lost the tab, and a person typing in that field lost the tab they were typing in.

**Not closing the menu by taking focus off its field.** Once the menu's frames had loaded again, blurring the field did close Bitwarden's menu and brought the next call to 0.92 s (median, 10 of 10). But it takes focus from whoever is typing: a person typing in the field lost the rest of their text 5 of 5, and a page's own autofocused field lost focus 4 of 5. A slower next call costs less than lost typing.

**Limits.** At 300 ms the tab is drivable again a median 2.2 s after the click, one call later in 6 of 10. Where `main`'s own retries outlasted the menu (next call 1.5 s later, or a field focused on load), the next call is slower: 0.91 → 1.22 s and 0.42 → 1.22 s, because a refused round now stops and waits for the next call. A follow-up could close the menu without moving focus.

A refusal for any other reason keeps `main`'s path: the tab is let go with its "navigate it in Chrome first" guidance.

## Testing

Real Bitwarden and 1Password, signed in to fixture logins in a macOS VM, Chrome 157, driven through `tab-supervisor` with no model (tables above and below). 1Password never made Chrome refuse in its six cells, so this PR's path did not run there, and tabs were kept in every try on both sides (10 or 20 tries per cell).

- `bun test test/tools/browser-relay-*.test.ts` in three shuffled orders: 230 of 230 each.
- The four held-out cases in `browser-relay-detach.test.ts` fail on `main` (4 of 19) and pass here; the case for any other refusal passes on both.
- `bun run check:ts` passes.

The 300 ms and person rows ran on this head. The others ran on the commit before the review fixes (an open now re-adopts a held-out tab; only a refusal over another extension's frame fails fast), which those cells do not reach. Not run: managers other than Bitwarden and 1Password, Chrome on Windows and Linux.

<details><summary>Model-facing texts</summary>

The failing call:

> Chrome detached omp from this tab (target_closed) before this call, so its code did not run. omp could not reattach to the tab: Chrome refuses the attach while another extension's frame, such as a password manager's inline autofill menu, is open in it, and that frame was still there after omp cleared it. omp kept the tab open as it is, and the next call on it reattaches to it; if that call fails the same way, the frame stays until the user closes it in Chrome (Escape, or a click elsewhere on the page)

The next call, which answered:

> Chrome had kept omp out of this tab since an earlier call (Chrome refuses the attach while another extension's frame, such as a password manager's inline autofill menu, is open in it); omp reattached to it on a new worker before this call, without reloading it. Tab state set since it was opened was reset (tab.route routes, emulation and user agent, init scripts, element ids, the request log, HAR recording, run globals).

</details>

<details><summary>1Password: tab kept on both sides in every cell</summary>

Chrome refused omp 0 times in every cell, on both sides. A call marked "detached" failed with `main`'s own report that the menu's frame loaded during it; the popup misses failed in `attach.ts` target selection ("Selected tab is not ready"), before any code this PR changes. Cells rerun on the final head have 20 tries.

| 1Password cell | Tab kept, `main` / PR | The cell's call, `main` / PR | Next call, `main` / PR |
|---|---|---|---|
| Field focused on load | 10/10 / 10/10 | | 10/10 / 10/10 |
| Log-in button to a focused field | 10/10 / 10/10 | 0/10 / 0/10 (detached) | 10/10 / 10/10 |
| Username then password with the menu open | 20/20 / 20/20 | 20/20 / 19/20 (detached) | 20/20 / 20/20 |
| Fill and submit with the save card | 10/10 / 10/10 | 0/10 / 0/10 (detached) | 10/10 / 10/10 |
| Click a field, then type | 20/20 / 20/20 | 20/20 / 19/20 (detached) | 20/20 / 20/20 |
| A popup the page opens | 20/20 / 20/20 | 16/20 / 13/20 (adopt) | 16/20 / 13/20 |

</details>

<details><summary>Reading order</summary>

`tab-supervisor.ts`: `recoverWorkerTab` (keeps a relay tab Chrome refused over another extension's frame, marks it `heldOut`, throws `TabHeldOutError`), then `readoptHeldOutTab` and its two callers (`runInTabWithSnapshot`, `acquireTabImpl`), `navigateOpenedTab` (no rollback for that refusal), `releaseTabInner` (no close sent to the dead worker). `tab-worker.ts` `#findAttachedTarget` fails at once on that refusal, which `relay/bridge.ts` now returns beside `Target.getTargetInfo`.

</details>

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
