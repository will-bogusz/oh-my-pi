## What

Agents page a SQLite `?q=` read with `&limit=` the same way they page a table or a JSON query, and `read` threw on it, so I made it page the query's rows instead.

Of the 14 recorded reads that hit this error, 8 now return rows and the other 6 get an error naming the fix.

| `read` path | main | this PR |
|---|---|---|
| `db.sqlite?q=SELECT …&limit=20` | `SQLite raw queries cannot be combined with table selectors or pagination` | the first 20 rows, then `[More rows; append ?q=…&limit=20&offset=20 to the database path to continue]` |
| `db.sqlite?q=SELECT …&limit=20&offset=40` | same error | rows 41-60, with the same footer |
| `db.sqlite?q=SELECT …` | up to 1000 rows | unchanged |
| `db.sqlite:users?q=SELECT …` | same error | `SQLite ?q= queries run against the whole database; drop ':users' from the path` |
| `db.sqlite?q=SELECT …&where=…` | same error | `SQLite ?q= queries take only limit and offset; put 'where' into the SQL` |

`limit` and `offset` mean what they mean on a table read: default 20, capped at 500.

## Why

The read prompt lists `?limit=` next to `?q=SELECT` for SQLite and pairs `?q=` with `&offset=&limit=` for JSON, so agents combine them. Every rejected read cost a turn to move the limit into the SQL and retry.

Decisions:
- The page runs inside SQLite: the query becomes a subquery under `LIMIT ? OFFSET ?`, so skipped rows are never built in JS. Statements that cannot nest (`PRAGMA`, `EXPLAIN`) fail to prepare that way and skip rows while iterating instead.
- A table selector with `?q=` still throws: the SQL names its own tables, and running it while ignoring `:users` would hide a selector the caller wrote. The error now says which part to drop.
- The tool prompt is unchanged.

Review first: `parseSqliteSelector` and `executeReadQuery` in `tools/sqlite-reader.ts`, then the `raw` case of `readSqlite`.

## Testing

- Replayed the 227 SQLite `read` paths recorded in my sessions since 10-01 through `parseSqliteSelector` on `main` and this branch: 8 errors become row pages, 6 table-selector errors keep failing with the new message, and the other 213 parse the same (206 successes, 7 unrelated errors). The 14 errors span 2 sessions, 10-03 to 10-06.
- One row at offset 20,000 of a query returning 64 KiB blobs: 1.7-2.4 ms through the subquery, against 69-78 ms when skipping rows while iterating.
- `bun test test/tools/sqlite.test.ts`: reads a page through `ReadTool`, follows its footer to the next page, pages an inner `LIMIT`, a CTE, a trailing `;`, a trailing `--` comment and a `PRAGMA`, and checks both new errors. With the source change reverted the paging and error tests fail; all 41 tests pass with it.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
