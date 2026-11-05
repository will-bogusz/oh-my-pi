## What

I made `browser.open({ viewport })` size the page the first time it opens a relay tab or an attached or visible browser; before, the size was dropped without a word until you opened the same name again.

A relay tab opened with `viewport: { width: 390, height: 844 }`: 1280×657 → 390×844.

| First `open({ viewport: 390×844 })` on | `main` | this PR |
|---|---|---|
| a relay tab omp opens | window size (1280×657) | 390×844 |
| an `app.cdp_url` browser (borrowed tab) | window size (900×557) | 390×844 |
| a visible (`headed`) managed Chromium | window size (1365×681) | 390×844 |
| a hidden headless tab | 390×844 | unchanged |

## Why

`buildInitPayload` never put `viewport` in the attach payload, and the tab worker applied one only to hidden headless tabs (#10095 stopped pinning the default 1365×768 on visible launches, which also dropped an explicit size). Reopening a live tab already applied it, so the same call gave different pages depending on whether the name was open. Since #14409 attached tabs report their real size, so the agent could see the request was ignored, with no error.

Decisions:
- The worker applies an explicit size with the same `page.setViewport` call the reopen path makes, so an omitted `scale` gives device scale 1 there too. Without `viewport`, a window omp does not size keeps its own size, as on `main`.
- It applies the size after the init steps that can fail (downloads folder, init scripts, network setup), so an open that fails leaves a borrowed tab at its own size.

Non-goals: cmux and Tern opens are unchanged. A borrowed tab keeps the size after omp releases it, as it already does on `main` after `tab.emulate({ viewport })` or a reopen with `viewport`: Chrome keeps the override on a page omp never navigated. Clearing it safely on release needs to know which handle set it, across handles on the same page and worker restarts, which is its own change.

Related: #14409.

## Testing

- `browser-attach.test.ts` "reports a connected browser's own viewport on open and observe, and applies one an open asks for" (a Chromium opened through `app.cdp_url`): an open with 390×844 whose `downloads` path is a file fails and the next open still sees the window's own size; an open with 390×844 then sizes the page and reports it. On `main` it fails at the size (the window's own); with the size applied before the downloads step, at the failed open (390×844 left behind).
- Live, an isolated relay with its own Chrome for Testing (not a user profile): the relay row above, `main` against this branch.
- Live, visible managed Chromium under Xvfb on Linux: the `headed` row.
- `browser-attach`, `-tab-worker-startup`, `-emulation`, `-relay-bridge`, `-relay-tab-isolation`, `-screenshot-plus`, `-open-lease`, `-worker-exit`: 197 pass (1 skipped), on Linux.
- No model sample set: the agent's own `viewport` argument now takes effect, and no text the model reads changes.

```sh
bun test packages/coding-agent/test/tools/browser-attach.test.ts -t "viewport"
```

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
