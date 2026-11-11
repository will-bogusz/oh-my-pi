## What

I made `select()` report what the page actually left selected after its change handlers ran, because Chrome tabs were echoing back the option we asked for even when the page had just reset it.

`tab.select()` and element-handle `select()` now return the option values the select holds after its `input` and `change` handlers ran, read from the live option list, on Chromium, cmux and Tern tabs.

| Page | Before | Now |
|---|---|---|
| Change handler keeps the choice | `["docs"]` | `["docs"]` |
| Change handler resets the select to its placeholder (jump menus, "add filter" menus), Chromium | `["docs"]` while the select shows `""` | `[""]` |
| Change handler replaces the options (cascading menus), all three backends | `["b"]`, an option no longer in the select | `["z"]`, what the new list has selected |
| `select()` with no values on a drop-down select, Chromium | `[]` while the browser re-selected the first option | `["m"]`, that first option |

## Why

The Puppeteer path computed its return value before dispatching the events, and cmux and Tern filtered the option array they captured before it, so an agent checking the result was told its choice stuck when the page had undone or replaced it. The page's handlers run inside `dispatchEvent`, so reading `select.options` after it sees what they did.

Non-goal: a handler that changes the value later (a timer or a fetch) is not waited for; the next read of the field shows it. Tern still leaves a drop-down select empty for `select()` with no values, as before.

## Testing

`browser-interactions.test.ts` "selects options by value, then by visible label, from tabs and element handles" gains a `#jump` select its change handler resets, a `#swap` select its handler refills (through the Chromium path, the cmux replay and the Tern page kit), and a no-value `select()`. With the fix reverted it fails on `reset`, `handleReset`, `cleared`, `swapped` and `ternSwapped`; with it, it passes. Run on macOS with headless Chrome for Testing: `bun test test/tools/browser-interactions.test.ts -t "selects options by value"`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
