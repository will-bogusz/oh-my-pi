## What

My TypeScript server was reaching 8+ GB in long sessions that touched a lot of worktrees, because omp never closes a file once it's opened, so now files nothing has used for 5 minutes get closed before the next one opens.

A language server keeps the project behind every open document loaded, and omp only sent `didClose` on a delete or rename, so every worktree or package a session touched stayed loaded until omp exited:

| `tsc --lsp` footprint (TypeScript 7.0.2) | `main` | this PR |
|---|---|---|
| after one query in this checkout and in 3 other worktrees | 6.46 GB | 6.45 GB |
| 6 min idle, one more file opened, then 5 min | 6.46 GB | 2.02 GB |

Reading order:
- `closeIdleFiles` and `OPEN_FILE_IDLE_MS` in `lsp/client.ts`: what closes and what stays open (overlays ahead of disk, documents mid-open, sync or refresh). It runs right before the `didOpen` in `ensureFileOpen` and `syncContent`; `OpenFile.lastUsedAt` marks each use.
- Reopening (`trackOpenedFile`, `LspClient.idleClosedFiles`): a reopened document resumes past its old version, `isProvisionalColdPublish` treats an empty or pre-reopen publish for it as provisional, and `reconcileFileFromDisk` reports the reopen so `code_actions` waits for fresh diagnostics.
- `refreshOpenFiles` (file created or deleted, `lsp reload`) is not a use and never reopens a closed document.

## Why

**The one maintainer decision: omp now closes documents it stopped using.** A query on a closed document reopens it, and its first answer may pay the project load again (2-3 s on this repo).

Closing happens right before an open, not on a timer, because that is when TypeScript servers act on it: after `didClose` alone a probe sat at 6.4 GB for 8 quiet minutes, and the next `didOpen` freed them within minutes.

#14710 first carried a 64-document LRU cap, dropped before merge because bursts kept more than 64 open. This counts time instead, since memory follows distinct projects: a burst keeps its documents, and the server holds what the last 5 minutes used (the mux's `SERVER_LINGER_MS`). No new setting.

Non-goals: per-worktree servers, a default `idleTimeoutMs`, mux memory limits.

## Testing

- Live, `tsc --lsp --stdio` 7.0.2 driving each branch's own client module with the script below. After the extra open, this branch reached 2.0-2.3 GB within 3-5 minutes in 3 runs (table: final head); `main` stayed at 6.46 GB.
- `test/tools/lsp-regressions.test.ts`, fake server: idle documents close before the next `didOpen`; refresh-all is not a use; a pending disk write keeps a document open; a close stuck on a server that stops reading stdin tears the client down, also with its opener cancelled before it was written; a cancelled opener's queued close still goes out, so the next query reopens with disk text; a late empty publish doesn't report a reopened document OK, nor a pre-close one its old errors; `code_actions` on a reopened document pulls fresh diagnostics. Each fails with its part reverted.
- `bun test test/tools/lsp-regressions.test.ts test/tools/lsp-diagnostics-freshness.test.ts test/lsp/ test/lsp-mux.test.ts`: 200 pass; `bun run check:ts` passes.
- Not run live: language servers other than TypeScript 7's native server.

<details><summary>Probe script</summary>

Save as `lsp-idle-probe.ts` at the root of the checkout under test, then `bun lsp-idle-probe.ts "$PWD" ../wt-a ../wt-b ../wt-c` (macOS, for `footprint`).

```ts
import { getOrCreateClient, reconcileFileFromDisk, sendRequest } from "./packages/coding-agent/src/lsp/client";
import { loadConfig } from "./packages/coding-agent/src/lsp/config";
import { fileToUri } from "./packages/coding-agent/src/lsp/utils";

const [root, ...worktrees] = process.argv.slice(2);
const client = await getOrCreateClient(loadConfig(root).servers["typescript-native"], root, 30_000);
const footprint = () =>
	Bun.spawnSync(["footprint", String(client.proc.pid)]).stdout.toString().match(/Footprint: (\d+ [KMG]B)/)?.[1];
async function query(file: string): Promise<void> {
	await reconcileFileFromDisk(client, file);
	await sendRequest(client, "textDocument/diagnostic", { textDocument: { uri: fileToUri(file) } }, undefined, 120_000);
	await Bun.sleep(2_000);
	console.log(`${file}: ${footprint()}, ${client.openFiles.size} open`);
}
for (const dir of [root, ...worktrees]) await query(`${dir}/packages/coding-agent/src/lsp/client.ts`);
await Bun.sleep(6 * 60_000);
await query(`${root}/packages/coding-agent/src/lsp/tool.ts`);
for (let seconds = 30; seconds <= 300; seconds += 30) {
	await Bun.sleep(30_000);
	console.log(`+${seconds}s: ${footprint()}`);
}
process.exit(0);
```

</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)



