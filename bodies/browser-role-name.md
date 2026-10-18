## What

I made `role/` work out an element's name the way `observe()` shows it, so the agent can copy a name from `observe()` into `role/button[name="…" exact]` and hit the element instead of getting "matches no elements".

On the fixture page below, 10 of the 11 buttons, links and text fields matched nothing on `main` when queried by the exact name `observe()` printed; with this PR all 11 match once, in Chromium and in Tern's page kit.

| Element | `observe()` name | `role/… exact` on `main` | this PR |
|---|---|---|---|
| `<button title="Open the cart">Cart</button>` | `Cart` | 0 | 1 |
| `<a href title="Help center">Help</a>` | `Help` | 0 | 1 |
| `<button><span aria-hidden="true">⚙</span> Settings</button>` | `Settings` | 0 | 1 |
| `<button>Save<span hidden>!</span></button>` | `Save` | 0 | 1 |
| `<button><img alt="bogusz's logo"> bogusz</button>` | `bogusz's logo bogusz` | 0 | 1 |
| `<button><span aria-label="Close dialog">×</span></button>` | `Close dialog` | 0 | 1 |
| `<button>Sign⏎     in</button>` | `Sign in` | 0 | 1 |
| `<button><div>Next</div><div>step</div></button>` | `Next step` | 0 | 1 |
| `<input type="submit">` | `Submit` | 0 | 1 |
| `<input placeholder="Email">` | `Email` | 0 | 1 |
| `<button title="Close"></button>` | `Close` | 1 | 1 |

## Why

`queryByRole` computed its own name from `title` and `textContent`. The accessibility tree that `observe()` reads, and the Tern kit's `accessibleName`, name these elements differently, so the names an agent copied were the ones `role/` could not find.

- **Name from content.** For roles named by their content (button, link, heading, option, tab, …; the Tern kit's `NAME_FROM_CONTENT` list), the text wins and `title` names the element only when the text is empty. Other roles take `title`, then `placeholder`; `main`'s placeholder fallback was unreachable, since an element's `textContent` is never null. Their text stays the last fallback, as on `main`.
- **Text** comes from one walker modelled on the Tern kit's `contentText`: it skips `aria-hidden` and `display: none` children and script/style, spaces block children apart, and uses a child's `aria-label` or an image's `alt`. `<label>` and `aria-labelledby` text go through it too.
- **Whitespace** is collapsed on both the computed name and the queried one. An empty `<input type="submit">`/`reset` is named `Submit`/`Reset`, and `alt` names only images, image inputs and areas, as in the Tern kit.

**Behaviour change:** a button or link whose `title` differs from its text no longer matches on the `title` (`role/button[name="Open the cart" exact]` 1 → 0), because `observe()` never shows that name.

Non-goals: cmux keeps its own role matching (`cmux-tab.ts`), so the CHANGELOG line names Chromium and Tern; shadow DOM text is not read, as on `main`.

## Testing

- `browser-queries.test.ts`: one `it.each` row per table case (except the unchanged `Close`) opens a fixture tab, takes the element's name from `observe()`, and expects `role/<role>[name="<that name>" exact]` to count 1. A second test checks the queried name collapses whitespace and the `title` control counts 0. All of them fail on `main` and pass here.
- Live: a local `Bun.serve` page with the table's elements, driven through omp's browser tool on headless Chromium and through the Tern page kit in Playwright's WebKit. Every name `observe()` listed matched once on both engines. Negative controls, names `observe()` does not show, matched 1 on `main` and 0 here: `button[name="Open the cart" exact]`, `button[name="⚙ Settings" exact]`, `link[name="Help center" exact]`.
- `bun run check:ts` passes. The Tern, interactions, observe and a11y suites pass, except `browser-observe`'s back/forward-cache test, which fails the same way on `main` with the headless shell used here.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
