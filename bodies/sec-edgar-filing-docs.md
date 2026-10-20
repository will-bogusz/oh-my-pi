## What

Agents asking `read` for a specific SEC filing kept getting the company's filing list back, so I made the EDGAR handler take only the company folder and leave filings to the normal page reader.

Of 110 `read` calls the SEC EDGAR handler answered in this machine's sessions, 104 asked for a filing document and got the company list instead; with this PR they get the document.

| `read` of | `main` | this PR |
|---|---|---|
| `sec.gov/Archives/edgar/data/88941/000008894126000028/smtc-07262026x8k991.htm` (an 8-K exhibit) | `Method: sec-edgar`, "# SEMTECH CORP … CIK … recent filings" | `Method: native`, the EX-99.1 press release |
| `…/data/<cik>/<accession>/`, `…-index.htm`, `….txt` | the company list | the page itself |
| `…/data/<cik>/` (the company folder), `browse-edgar?CIK=`, `data.sec.gov/submissions/…` | the company list | unchanged |

## Why

`extractCik` matched `/Archives/edgar/data/<cik>` as a prefix, so every filing, exhibit and index page below a company's folder was answered from `data.sec.gov/submissions/CIK….json`: the company's name, tickers and last filings, under the requested URL and with no note. Four autoqa reports say exactly that ("returns the company's filings index instead of the document"). Agents then retried with `:raw`, which skips the handler, and on `main` that hits SEC's 403 for `curl/8.0`.

The documents load through `loadPage`'s user-agent fallback (TextBot gets them where curl gets a 403), which moves past SEC's plain 403 page because `loadPage` rotates user agents on the status code. SEC asks automated tools to declare a contact address in `User-Agent`; omp has none to declare, and the handler's own `data.sec.gov` requests send `omp/<version>` as before.

Decision: the accession folder and `-index.htm` go to the page reader too. They are HTML listings of that filing's documents, which is what someone asking for them wants; the company list answers a different question.

## Testing

- `bun test test/tools/sec-edgar-filing-docs.test.ts` (offline, `loadPage` stubbed): a document, an `-index.htm`, a `.txt` and an accession folder return `null` from the handler without calling `data.sec.gov`, and the company folder with or without the trailing slash still lists filings. The first fails with `sec-edgar.ts` from `main`.
- `WEB_FETCH_INTEGRATION=1 bun test test/tools/web-scrapers/business.test.ts -t handleSecEdgar` (live): 6 pass, with the Archives case moved to the company folder plus a document case that expects `null`.
- `omp read` live, `main` → branch: a 6-K and an 8-K exhibit from the autoqa reports went from the company list to the document text.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
