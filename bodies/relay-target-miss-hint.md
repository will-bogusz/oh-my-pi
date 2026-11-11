## What

I fixed the relay's "no tab matched" error, which still told agents to omit the target "to use the active tab", a route relay opens stopped taking once they began opening omp's own tab.

The error's last sentence now reads: "Pass a target id, URL or title substring (browser.targets() lists URLs before adopting), or omit target to open omp's own tab, with url to load the page there". Adopting by target and the list of available pages are unchanged.

## Why

Since #16119 a relay `browser.open` without `app.target` creates omp's own tab and leaves the user's tab alone (`buildInitPayload` in `tools/browser/tab-supervisor.ts`), as the browser guide says. The miss error in `selectRelayEntry` (`tools/browser/attach.ts`) kept the old advice, so an agent whose target missed was told to take the user's active tab, which no longer happens.

That moment is where agents leave the browser tool. Across our own agent sessions, 50 of 82 Chrome AppleScript calls in the user's real browser (opening, re-navigating and closing tabs) came right after a relay error, and 22 of those 50 came after this message; most of the 22 predate #16119, when the advice was still true, which is why it needs to name the route that works now.

The same line also changes inside a larger relay change still waiting in our queue; this splits it out so the wrong advice does not wait on that one.

## Testing

The relay miss test (`pickElectronTarget relay path > lists relay page ids with their URLs when a target id is missing`) runs `pickElectronTarget` against a served `/json` listing and now also checks that the error names the own-tab open and no longer mentions the active tab. With the fix reverted it fails on the old "omit it to use the active tab" text.

```
cd packages/coding-agent && bun test test/tools/browser-attach.test.ts   # 50 pass
```

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
