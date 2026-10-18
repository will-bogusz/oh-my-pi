## What

I kept getting "No references found" from rust-analyzer on files in my other git worktrees, because omp only ever told the server about the session's checkout, so now that checkout gets added to the running server's workspace the first time a file there is opened.

References on a Rust function in a sibling worktree go from none on every call to all 4 callers on the first call, with the same single rust-analyzer process.

| `lsp references` on a Rust fn in a sibling checkout (session cwd at the other one) | `main` | this PR |
|---|---|---|
| First call | `No references found` | `Found 4 reference(s)` (2.4 s warm, 3.1 s cold) |
| 3 more calls, 5 s apart | `No references found` each time | 4 each time |
| rust-analyzer processes / RSS | 1 / 543 MB | 1 / 605 MB |

> **LSP context.** omp starts a server with one workspace folder, the session cwd, and rust-analyzer only indexes crates under its folders. LSP lets a client add folders later (`workspace/didChangeWorkspaceFolders`) when the server advertises `workspace.workspaceFolders.changeNotifications`.

Reading order:
- `ensureWorkspaceFolder` in `lsp/client.ts`, before the first `didOpen`: adds the file's checkout (symlinks resolved, nearest `.git`) unless it is the session's, already added, or holds the home directory.
- `restartProjectLoad`: a pending project-load wait is extended, so callers already waiting see the new load.
- `sendRequest`: after an add, a ContentModified (`-32801`) cancellation is retried once within the request's timeout, never for `workspace/executeCommand`.
- `lsp/tool.ts`: `diagnostics` and `rename_file` (every source and destination) add checkouts before waiting or asking the server.

## Why

In my sessions, 70 of 106 `lsp references` calls on Rust files in a sibling worktree came back empty with rust-analyzer ready.

- One server per session. A server per checkout also fixes Rust, but adds a process per worktree plus per-checkout config, reload and idle handling; I built that first and dropped it.
- Servers that don't advertise folder changes keep `main`'s behaviour. `tsc --lsp` 7.0 doesn't, and already answers same-file references in another checkout.
- Added folders stay until the server exits.

Related: #15418 (ours) closes idle documents; it closes ones from an added folder too, and the folder stays.

## Testing

- Live (Linux, rust-analyzer 0.3.3081): crates `main/` and `feature/` with `.git`, session cwd `main/`, `references` on `helper` in `feature/src/lib.rs` through `LspTool.execute`, numbers above. TypeScript, both checkouts open: one `tsc` on both branches (3126 vs 3155 MB), same answers.
- `bun test test/tools/lsp-regressions.test.ts -t "another checkout"`: 10 pass; on `main` 8 fail, the 2 passing guard `main`'s behaviour (no capability, home-directory checkout).
- LSP test files: 230 pass, 0 fail (220 on `main`). `bun run check` in `packages/coding-agent` passes. Merged with #15418: 243 pass, check passes.
- Not run: Windows and macOS.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
