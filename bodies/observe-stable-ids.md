## What

I made an element keep its `observe()` id while it stays on the page, so an id from an earlier look can no longer click whatever element took its number.

`observe()` numbered from 1 on every call. After a list re-rendered, `tab.id(1)` from the previous look named a different button, and the click landed there with no error. On Chromium and Tern tabs an element now keeps its id across observations while it stays in its document; once it is removed or the page navigates, its id fails as stale and is not handed to another element. cmux ids are cmux's own refs and are unchanged.

| | main | this PR |
|---|---|---|
| Gamma inserted before Alpha, Beta removed, then `tab.id(1).click()` with Alpha's old id | clicks Gamma | clicks Alpha (id 1 in both looks) |
| Beta's old id | resolves to a neighbour | `Element id 2 is stale` |
| id after a navigation | `Unknown element id` | `Element id N is stale`, numbering continues |

IDs name the original node in its original document, never a replacement with a matching role or label. Releasing a cached handle does not make its still-live element stale. Chromium retains the 5,000 most recently observed elements beyond the latest listing; evicted ids fail stale rather than being recycled. Tern uses per-document identity; cmux keeps its own refs.

Rejected: re-attaching an id to a "same" element by role, name and position after a re-render. On a list that re-renders after a delete, the old row's Remove id would land on the next row's Remove.

## Open questions

- **The numbering contract.** A script doing `tab.id(1)` after a fresh `observe()` to mean "the first element" now breaks. I recommend accepting that: the old behaviour silently acts on the wrong element.
- **Worker restarts.** A cell timeout or renderer crash adopts the page in a new worker, which numbers from 1 again; its result already says element ids were reset, and the prompt says so. Carrying the counter into the new worker would close that too, at the cost of a field in the worker init payload.

## Testing

`bun test packages/coding-agent/test/tools/browser-observe.test.ts packages/coding-agent/test/tools/browser-tern-tab.test.ts`: `browser observe ids` covers the re-render and navigation case on Chromium and in Tern's kit (both fail on main, where ids renumber and the click lands on the inserted button), a released or disposed cached handle, the 5,000-id cap, and Tern `includeAll` text entries; the Tern tab test checks the next observe starts after the tab's highest id. The back/forward cache test now expects the stale message.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
