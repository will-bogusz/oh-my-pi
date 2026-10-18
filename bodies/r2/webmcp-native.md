## What

I made omp stop changing every page it drives just in case the model calls WebMCP: the `webmcp*` helpers now read Chrome's own WebMCP when they're called, and say plainly when Chrome offers the page none.

| what the page itself sees / what `webmcp*` return | `main` | this PR |
|---|---|---|
| omp's own tab, driven without `webmcp*` (relay, Chrome for Testing 150) | `__ompWebMcpBridge_v1` global, `ModelContext.prototype.registerTool` wrapped: 5/5 | page untouched: 0/5 |
| the user's own tab omp attaches to (relay, CfT 150) | same, injected into the loaded page: 5/5 | untouched: 0/5 |
| the same two tabs in Chrome 155 stable (`cdp_url`, no origin trial) | a polyfilled `modelContext` plus the global: 5/5 and 5/5 | untouched: 0/5 and 0/5 |
| WebMCP page (`<form toolname>` + `registerTool`), CfT 150 relay | both tools listed, invoke returns `{total: 42}`: 5/5 | same: 5/5 |
| origin-trial demo page, Chrome 155 stable | 7 tools listed, `set_pizza_size` invoked: 5/5 | same: 5/5 |
| page that calls `registerTool` where Chrome has no WebMCP (CfT `--disable-field-trial-config`; Chrome 155 without the trial) | the polyfill takes the tool; listed and invoked: 5/5 and 5/5 | `status: "unavailable"` with the reason; `webmcpInvoke` throws it: 5/5 and 5/5 |

**The maintainer decision: this reverses the page-hook contract from `d49918fab2` (Tern's copy: `4819e4f6d5`; hardened in #15118).** A page that registers its tools on a `modelContext` it finds no longer gets omp's polyfill where Chrome doesn't expose WebMCP: Chrome before 147, Chrome stable on sites without the WebMCP origin trial (149-156) unless started with `--enable-features=WebMCP`, insecure contexts (`http:` other than localhost, `data:` URLs, also in browsers omp launches), and every Tern tab (WKWebView). Chrome 147-148 list tools but cannot invoke them. Pages that bring their own `modelContext` polyfill are no longer mirrored. In exchange omp never changes a page it doesn't use WebMCP on, including the user's own tabs over the relay or `cdp_url`. Restoring the polyfill would mean restoring the hook.

> **WebMCP context.** Sites register agent tools with `document.modelContext.registerTool` or a `<form toolname>`; Chrome exposes them through an experimental DevTools `WebMCP` domain (listing since 147, invoking since 149), which omp now reads.

## Why

Every tab worker installed the hook at init (`evaluateOnNewDocument` plus a main-world eval in each frame) and polyfilled `modelContext` where it was missing, so every page omp touched saw a changed global whether or not WebMCP was used; #15118 had to stop that hook getting renderers killed.

<details><summary>How omp reads Chrome's WebMCP now</summary>

- Each call re-sends `WebMCP.enable` on every CDP session of the tab. Chrome replays the session's root frame's tools before answering, so navigations and back/forward restores need no bookkeeping. Frames sharing their parent's session aren't replayed: omp follows their announcements from tab init (Puppeteer already enables the domain when it attaches; omp only listens) and drops them when the frame loads another document. Cross-origin iframes are read on their own session.
- `WebMCP.enable` succeeds with the feature off, so with no tools omp checks `"modelContext" in document` in Puppeteer's isolated world: it neither creates the page's context nor sees page globals.
- An aborted or timed-out `webmcpInvoke` cancels the invocation and never starts one after the abort. A tool that throws now returns its message (main returned an empty error).
- Tern refuses `webmcp*` like cmux.

</details>

<details><summary>Maintenance and non-goals</summary>

Maintenance: the domain is experimental; if Chrome changes it, `webmcp*` report it missing, all in `browser/webmcp.ts`. Non-goals: the Web Vitals observer omp also installs at tab init (`__ompBrowserVitals`); child-frame tools registered before omp attached to an existing tab, which Chrome doesn't replay (main can't see them either).

</details>

## Testing

- `browser-webmcp.test.ts`, headless Chromium, 11 tests: no omp global, wrapped method or polyfill before or after `webmcpList`; native list/invoke/events; the two unavailable reasons; cross-origin and same-process iframes; navigation and back/forward cache; abort before and after start; a removed iframe's session released. With `src` reverted, 9 of 11 fail.
- Live, rows above: relay harness (isolated CfT 150, relay and extension from each checkout) and Chrome 155 stable in a macOS VM via `cdp_url`; each page reports what it sees from its own main world. Relay rows rerun with omp opening its own background relay tab (with #15110, the earlier version of #16119): same.
- `browser-webmcp.test.ts` with `browser-tab-worker-startup` and the `browser-relay-*` files: 166 pass, 1 skipped; `bun check` passes. Not run: Chrome 147-148 (no build here).

```sh
bun test packages/coding-agent/test/tools/browser-webmcp.test.ts
```

Review first: `WebMcpController.#refreshCatalog` in `browser/webmcp.ts`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)




