## What

Reading an SEC filing link was handing my agents the company's profile instead of the 10-Q or exhibit they asked for, so now only the bare company folder gets the profile and filing documents come back as themselves.

`read` of an EDGAR filing document now returns that document; on `main` every URL under `sec.gov/Archives/edgar/data/<cik>/` returned the same company card.

| URL `read` | `main` | This PR |
|---|---|---|
| `…/Archives/edgar/data/<cik>/<accession>/<doc>.htm` (a 10-Q, 6-K, exhibit) | company name, address, last 20 filings (`Method: sec-edgar`) | the document text, through the generic page reader (`Method: native`) |
| `…/Archives/edgar/data/<cik>/<accession>/` (a filing's folder) | same company card | SEC's file listing for that filing |
| `…/Archives/edgar/data/<cik>/` (the company's folder) | company card | company card (unchanged) |
| `?CIK=`, `/cik/<n>`, `data.sec.gov/submissions/CIK<n>.json` | company card | unchanged |

## Why

The SEC EDGAR scraper (`web/scrapers/sec-edgar.ts`) takes over any `sec.gov` URL it can pull a CIK from and renders `data.sec.gov/submissions/CIK<n>.json`. Its `/Archives/edgar/data/(\d+)` pattern was unanchored, so it also matched every document path under the company and dropped the document. Agents reading earnings exhibits and 10-Qs got the filings list back, retried, and fell back to `curl`. `extractCik` now matches only `^/Archives/edgar/data/<cik>/?$`; deeper paths return `null`, and `read` fetches them like any other page (SEC's user-agent requirement is already handled there).

Rejected: rendering the filing through EDGAR's API as well. The document's own HTML is what the agent asked for, and the generic reader already renders it.

Non-goal: very deep inline-XBRL 10-Q pages still fall back to raw HTML, because the native HTML converter stops at its DOM depth limit of 64. That limit is separate and unchanged here; the raw HTML is still the requested document.

## Testing

- `bun test test/tools/web-scrapers/sec-edgar.test.ts` (`packages/coding-agent`): a document URL and a filing-folder URL return `null` without fetching the submissions API, and the company folder still renders the profile from `CIK0002120882.json`. With the fix reverted the first test fails: the 6-K URL returns the `# Example Holdings Ltd` profile.
- `WEB_FETCH_INTEGRATION=1 bun test test/tools/web-scrapers/business.test.ts -t handleSecEdgar`: 5 pass against the live SEC API. Its Archives case asserted that a 10-K document URL returns Apple's profile; it now reads Apple's company folder.
- Live `read` through `ReadTool` on the branch: Semtech's exhibit 99.1 (`/Archives/edgar/data/88941/000008894126000028/smtc-07262026x8k991.htm`) returns the earnings release text, `Method: native`; on `main` the same URL returns `# SEMTECH CORP` with `Method: sec-edgar`. A 6-K document and a filing folder return the document and SEC's listing; `/Archives/edgar/data/320193/` still returns Apple's card.

---

- [x] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
