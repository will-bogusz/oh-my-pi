## What

My project's custom tool imports `@oh-my-pi/pi-natives`, and in the installed `omp` it never loaded, while an extension importing the same package in the same process worked; custom tools now load through the same host-package loader as extensions.

| Custom tool in `.omp/tools/` | `omp` binary built from `main` | Built from this PR |
|---|---|---|
| `import { … } from "@oh-my-pi/pi-natives"` | `Cannot find package '@oh-my-pi/pi-natives'`, tool missing | loads (`natives_probe:function`) |
| `import { logger } from "@oh-my-pi/pi-utils"` | `Cannot find package '@oh-my-pi/pi-utils'` | loads (`utils_probe:object`) |
| Extension with the same imports | loads | loads (unchanged) |

The failure is logged on every session start; my logs held 375 of these errors from one tool, the last on 18.12.3.

## Why

Extensions load through `loadLegacyPiModule`, which rewrites `@oh-my-pi/*` (and the legacy `@mariozechner/*`, `@earendil-works/*`) specifiers to the bundled copy before Bun evaluates them. Custom tools used a plain `import()`, and inside the compiled binary there is no `node_modules` copy to resolve, so any value import of a host package failed. In a source checkout the workspace resolves it, which is why tests never saw it.

Decisions:
- `loadLegacyPiModule` gains `reload: false` (its `import()` of a runtime path is the one it already had, minus the `?mtime` tag). Extensions keep re-evaluating on every load (that is how edits are picked up); custom tools keep `main`'s semantics: a tool module and its relative helpers are evaluated once per process and shared between tools, and each session still calls the factory with its own API. Without this, every SDK session re-ran tool modules and two tools stopped sharing a helper (found in review).
- A CommonJS tool's namespace `default` is its whole `module.exports` through the shim, so transpiled `exports.default = factory` is unwrapped one level, as Bun's native import did.

Related: #8900 / #9110 (a value import of `@oh-my-pi/pi-coding-agent` recursing at startup) and #8901 (bun-cache installs); both are about source installs, not the binary, and this changes neither.

## Testing

- Live: built `omp` from `main` and from this branch (`bun run build`), then ran `-p` with Haiku 5.5 in a scratch project whose `.omp/tools/` hold two probes importing `@oh-my-pi/pi-natives` and `@oh-my-pi/pi-utils` (results in the table), and in this repo, whose `.omp/tools/tui.ts` imports pi-natives: `main` logs 1 `Custom tool load failed` per session, this PR 0.
- `bun test packages/coding-agent/test/extensibility/custom-tool-loader.test.ts`: 12 pass. The two host-import cases (a temp-dir tool importing `@oh-my-pi/pi-utils` and `@mariozechner/pi-utils`) fail on `main`; the module-identity and transpiled-CommonJS cases pass on `main` and fail if custom tools use the reloading loader.
- `bun test packages/coding-agent/test/extensibility`: 279 pass.
- Not run: Windows and Linux binaries.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
