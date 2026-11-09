Follow-up to #18632 and its [post-merge Codex findings](https://github.com/can1357/oh-my-pi/pull/18632#pullrequestreview-5833713075).

## What

I fixed the locale-sensitive role lookup and document-root waits that slipped through the Chromium role-selector change.

| Browser action | Before | Now |
|---|---|---|
| Tern input observation and role selection under Turkish casing | Inputs disappear | Input roles and names remain selectable |
| Chrome `role/RootWebArea` visibility wait | Throws an element-layout TypeError | Visible resolves; hidden keeps waiting |

This changes neither the role candidate set nor the accessibility-tree lookup design.

## Why

HTML tags, input types and ARIA role identifiers are locale-independent, unlike human-readable names. Shared Tern rules now normalize those identifiers without the host locale. Document roots have no element layout APIs, so Chrome waits treat them as visible instead of asking Puppeteer's element visibility helpers.

The customized-built-in finding is invalid: Chromium throws `NotSupportedError` when an `HTMLSpanElement` subclass calls `attachInternals()`. The candidate filter stays narrow, with a comment explaining that restriction.

Review the identifier/name boundary and document-root visibility branch first. These remain browser semantics, covered by live Chromium fixtures; a future browser change should surface in those tests rather than require another role table.

## Testing

- `bun test packages/coding-agent/test/tools/browser-role-ax.test.ts`: 11 passed, 0 failed, running real headless Chromium and the serialized Tern kit.
- Negative controls with the final tests against unchanged `origin/main` source: 0 passed, 2 failed. Document-root visible wait throws `getComputedStyle` TypeError; the Turkish fixture loses both inputs and all three role counts are zero. Independently reverting only the hidden-wait guard also reproduces the layout TypeError.
- Turkish casing uses V8's native `toLocaleLowerCase("tr")` as the default inside the isolated test page; CDP's locale override changes Intl but does not change V8's default string casing on this Mac.
- `bun run --cwd packages/coding-agent check:types`: no errors in 4,891 files.
- `bunx oxfmt --check` on the three touched files: passed.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (added under Unreleased; PR link and credit are added when opened)
