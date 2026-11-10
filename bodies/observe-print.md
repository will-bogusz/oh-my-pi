## What

Printing an observe() result quietly dropped every element after the 100th, so the model never knew those controls existed; I made it print every element, one per line.

For a 160-element page, `print(await tab.observe())` goes from 100 elements and `... 60 more items` (17,629 characters) to all 160 (3,860):

```text
main (cut where marked …):
{
  url: 'https://example.test/list',
  …
  elements: [
    {
      id: 1,
      role: 'button',
      name: 'Item 1',
      value: undefined,
      description: undefined,
      keyshortcuts: undefined,
      states: []
    },
    …
    ... 60 more items
  ]
}

this PR:
url: "https://example.test/list"
…
elements (160; tab.id(n) acts on [n]):
[1] button "Item 1"
[2] textbox "Name" value="Ada" focused required
…
[160] button "Item 160"
```

The object, its keys, `.elements` and its JSON are unchanged, so code that reads elements is unaffected.

## Why

`util.inspect`, which prints every Eval value, stops arrays at 100 items and says only how many it left out. Of 623 printed observations in bench runs, 20 were cut, hiding 3,901 elements; on 34 captured real pages, 11 lost controls. A control past the cut has no id the model can see.

- The form is inspect's custom-print hook on `tab.observe()` results only. Nested in another value (`return { text, o }`, which models write) the lines sit inside `Observation { … }`; with `elements` replaced it prints as before.
- Raising inspect's array limit for every print was rejected: a 10 MB `Uint8Array` would print as 33 million characters instead of its length.
- Every field an element has stays, in a fixed order, strings JSON-quoted. A huge page still meets the 50 KiB output cap, which says so and keeps the full text as an artifact.

Non-goals: Python (its dict print has no cut), `tab.run` return values, other helpers' arrays.

## Testing

- `test/eval/browser-prelude-facade.test.ts`: a 150-element observation through `executeJs` shows all 150 lines when printed, as the cell's value, as `.elements` and nested; JSON and keys unchanged. Fails with `prelude.js` reverted.
- Live, headless Chromium, 160 buttons: `main` printed 100 and `... 60 more items`, this branch all 160.
- Replaying 472 recorded bench runs with their usage: 51.7 → 14.5 tokens per printed element; input tokens −4.1%, cache-weighted input cost −5.5%, counting the hidden elements now printed.
- Haiku 5.5, 4 bench web tasks × 3 runs per arm, interleaved (n=12 each, small): pass 10/12 on both; steps ratio 1.10 [0.94, 1.28], input tokens 1.06 [0.91, 1.25] (95% bootstrap). Runs here that never printed an observation showed the same spread, so it is noise. After a printed observation, 14 of 15 cells calling `tab.id()` used an id from it.
- Not run yet: GPT-6.1 Sol on the same tasks, queued behind other bench legs.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
