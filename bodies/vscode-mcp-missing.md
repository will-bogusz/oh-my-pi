## What

Almost every omp startup was writing a "[VS Code] Failed to read …/.vscode/mcp.json" warning into the log just because the project has no VS Code MCP config, so I made the VS Code provider skip a missing file and keep warning only when the file is there but can't be read.

A one-shot session in a project without `.vscode/mcp.json` now logs 0 warnings instead of 1 (5 of 5 runs each).

| `.vscode/mcp.json` | `main` | this PR |
|---|---|---|
| missing | `warn` "[VS Code] Failed to read <cwd>/.vscode/mcp.json" | nothing |
| present, unreadable or a directory | `warn` "Failed to read …" | same |
| present, invalid JSON | `warn` "Invalid JSON in …" | same |
| present, valid | servers loaded | same |

## Why

`loadMCPConfig` in `discovery/vscode.ts` treated `readFile` returning `null` as a read failure, but `capability/fs.ts` returns `null` for a missing path, which is the normal case. Since `mcp/config.ts` began logging every discovery warning at `warn` level, that turned into one warning per session in nearly every project, burying real warnings in the log.

The fix returns early when `readFile` returns `null` and a `stat` says the path does not exist, the same split `discovery/agent-plugins.ts` makes for plugin `mcp.json` files. A `.vscode/mcp.json` that exists but can't be read (a directory, mode 000) still warns, so the user's servers never vanish silently; the `stat` runs only when the read failed. I rejected returning silently on every `null`, as `discovery/mcp-json.ts` does, because it would also hide those. An empty file now reports "Invalid JSON" rather than "Failed to read".

## Testing

- `packages/coding-agent/test/discovery/vscode-mcp.test.ts`: a project without `.vscode/mcp.json` yields no warnings; an unparsable, a directory and an unreadable one each still warn. With the fix reverted, the missing-file test fails (1 warning received); with an early return on every `null` instead, the directory and unreadable tests fail.
- Live, from the worktree: `omp -p "reply ok" --model anthropic/claude-haiku-5-5` in 5 fresh temp dirs per arm, counting lines of that process's log. `main`: 1 warn line per run (the VS Code one, the only warning); this PR: 0 warn lines in 5 of 5, 6 log lines instead of 7. A temp dir with a broken `.vscode/mcp.json` still logs "Invalid JSON in …".
- `bun test packages/coding-agent/test/discovery/`: 229 pass; `bun run check` in `packages/coding-agent` passes.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
