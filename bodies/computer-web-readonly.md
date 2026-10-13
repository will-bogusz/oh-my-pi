## What

A read-only field on a web page showed up in `ax()` exactly like one you can type into, so I made its line say the page won't let anyone edit it.

On macOS, an `ax()` line now ends in `(readonly)` for a web page's text field or text area that the page declares read-only (`readonly`, `aria-readonly`), as in `- textfield "Fixed" [ref=e29]: "fixed" (readonly)`. Editable fields and `(disabled)` ones read as before.

> **macOS context.** A browser reports, per element, whether accessibility clients may set its `AXValue`. Chrome and Electron answer no for exactly the page's read-only and disabled text fields, and yes for every editable kind we tried.

Reading order: `desktop/ax.rs` `walk_raw` (the `readonly` flag) → `format_tree` → `macos/ax.rs` `value_read_only` / `attribute_settable_answer`.

## Why

**Builds on #15282**: this branch is #15282's head plus 3 commits; merge #15282 first, or merge this alone to land both. It reads settability through #15282's walk, which already tracks whether a node sits in web content. **Overlaps** the item-8 focus branch on `will/computer-ax-focus` (stacked on #15282) in `format_tree` and the backend trait: adjacent lines, no shared logic.

- **Decisions.** Web content only: outside it an unsettable `AXValue` proves nothing (a terminal's text area reports it and still takes keys). The mark is the page's declaration, not a guarantee: a contenteditable with `aria-readonly` can still accept keys. A failed settability query marks nothing.
- **Non-goals.** Combo boxes (a choice-only popup has no text to set, so the answer would mislead), number inputs (Chrome exposes them as `incrementor`; Safari adds a stepper child whose answer means something else), Linux and Windows.
- **Cost.** One settability query per enabled web text field per `ax()`; `find()` asks none.

## Testing

Live on a macOS 26.5 VM: the user's app in front, a Chrome page with 12 fields behind it, `win.ax()` from scripted computer-tool cells; every field's line read back.

| Live `ax()` lines, Chrome page behind the user's app | #15282 `8c323e882d` | this PR `afcc9b4d55` |
|---|---|---|
| `readonly` input, `readonly` textarea, `aria-readonly` textbox, Chrome (5 runs) | 0/15 marked | 15/15 `(readonly)` |
| The same 3 fields in Electron 38 (1 run) | 0/3 | 3/3 |
| 8 editable fields: text, textarea, 2 contenteditable, number, password, search, React-style controlled (5 runs) | 0/40 marked | 0/40 marked |
| `disabled` input | `(disabled)` 5/5 | `(disabled)` 5/5 |
| User's app lost focus | 0/5 | 0/5 |

- `cargo test -p pi-natives --lib -- desktop::ax`: 23 pass. `only_page_text_fields_answering_unsettable_are_marked_readonly` fails with the `(readonly)` line removed.
- `cargo fmt --check`, `cargo clippy -p pi-natives --no-deps -- -D warnings`: clean.
- Safari, read with a standalone accessibility probe rather than omp: the same 3 read-only fields answer unsettable and the editable ones settable. omp itself was not run against Safari, Linux or Windows.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
