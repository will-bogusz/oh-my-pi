## What

I made the Read the Docs reader take only an Edit link that points at the page's own source file, because any link mentioning "source" counted as the Edit link and pulled in other projects' files.

Reading `https://docker-minecraft-server.readthedocs.io/en/latest/misc/deployment/` returned the `mother-of-all-self-hosting/mash-playbook` "Supported services" table (45 KB of unrelated services) instead of the Deployment page, because the page body links to it as "wide variety of open-source services". With this PR the Read the Docs reader fetches raw source only from a GitHub/GitLab link labelled Edit whose file path ends with the page's own path (`misc/deployment/` → `docs/misc/deployment.md`, `user/quickstart.html` → `docs/user/quickstart.rst`, the docs root → an `index`/`README` file). Any other page gets its HTML converted, as pages without an Edit link already do.

| Page (read live) | `main` | This PR |
|---|---|---|
| docker-minecraft-server `/en/latest/misc/deployment/` | `mash-playbook/.../supported-services.md` (another repo) | page HTML |
| pydata-sphinx-theme `/en/stable/user_guide/layout.html` | `src/.../components/edit-this-page.html` (695 B template the page mentions) | `docs/user_guide/layout.rst` (the page's source) |
| jupyter-notebook `Importing%20Notebooks.html`, sphinx-rtd-theme `configuring.html` and root, requests quickstart, mkdocs configuration, docs-python2readthedocs `code-doc.html` | same as PR | same as `main` |

## Why

#17091 made the reader skip an Edit link whose git ref doesn't match a pinned docs version, but `latest` and `stable` accept any ref, and nothing checked that the link was the page's Edit link at all: the loop took the first link anywhere on the page whose text contained "edit" or "source". Related: #16835.

**Decisions:**
- Match the linked file to the page path rather than to each theme's Edit-link markup. sphinx-rtd-theme, pydata, furo and the mkdocs themes place and mark that link differently, so a selector list would need upkeep per theme; the page path is what every builder shares. Paths compare decoded (`Importing%20Notebooks.html` ↔ `Importing Notebooks.ipynb`), and only `.html` is stripped from the page, so a dirhtml page `package.module/` still matches `package.module.rst`.
- Drop "source" as a link label. The Edit links on the live pages above all read "Edit on GitHub"; "source" matched body prose like "open-source".

**Non-goals:** Edit links without visible text (mkdocs-material's icon button) still are not followed, as on `main`; the ref/version rule from #17091 is unchanged. A body link labelled "edit" that points at a same-named file in another repo would still pass; telling it from the real one needs the project's repository URL, which the page doesn't reliably carry.

## Testing

- `packages/coding-agent/test/tools/web-scrapers/readthedocs.test.ts`, 9/9 pass. Three new cases fail on `main`'s `readthedocs.ts`: the deployment page's "open-source" body link, an Edit link to a non-index file on the docs root page, and an Edit link to a file other than the page's. Three more pin what must keep fetching source: the root page's `docs/index.rst`, a percent-encoded page path, a dotted dirhtml page.
- Live: the table above, calling `handleReadTheDocs` on each URL with `main`'s file and with this branch's.
- `bun run check:ts` (oxlint, oxfmt, every package's types): clean.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
