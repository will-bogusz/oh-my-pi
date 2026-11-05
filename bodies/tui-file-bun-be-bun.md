## What

Driving omp's own TUI through `xd://tui` from the installed omp kept sending the cli.ts path in as my first prompt, so every session started with a model turn nobody asked for; this runs the entry with bun instead.

The repo's TUI debug tool (`.omp/tools/tui.ts`) starts a `file` entry as `[process.execPath, <file>, ...args]`. Under the compiled `omp` binary `process.execPath` is omp, not Bun, so omp parses the entry path as a positional prompt:

| `start` with a `file` entry, host is the compiled omp | `main` | this PR |
|---|---|---|
| default entry (`packages/coding-agent/src/cli.ts`) | source omp opens and submits the cli.ts path as a user message | source omp opens with an empty prompt |
| a probe script with `args: ["--help"]` | omp's own `--help`; the entry never runs | the entry runs with `argv` `["--help"]` |

`bin` targets and a tool hosted from source (`process.execPath` is already Bun) are unchanged.

## Why

When the host `isCompiledBinary()`, `file` entries run with `Bun.which("bun")`. The tool already needs that `bun`: its docs install `.omp/tools` with `bun install --cwd .omp/tools`. With none on `PATH`, `start` fails with an error that points at `bin`, and no session or temp dir is created.

Decision: **not `BUN_BE_BUN=1`** on the omp binary, the re-entry `plugins/bun-cli.ts` uses for `bun install`. Here the child is a long-lived app that runs commands of its own: the flag would reach every one of them, so an `omp` run from the debugged session's bash tool would act as Bun (`BUN_BE_BUN=1 omp --version` prints `1.4.4`). A source-run omp child also re-enters its own `process.execPath` for workers and `/restart`, so the flag could not be scrubbed at its entry either. With a real bun, the child's `process.execPath` is Bun and both work as they do from source.

## Testing

- Live, compiled omp 18.16.0 with this worktree as cwd (so it loads the branch's `tui.ts`): `start {file: argv.ts, args: ["--help","x y"]}` printed `ARGV=["--help","x y"] EXEC=~/.bun/bin/bun BUN_BE_BUN=undefined`; on `main` the same call printed omp's `--help`. `start` with the default entry opened the source omp TUI with an empty prompt.
- `bun test ./.omp/tests/tui.test.ts`: 5 pass, 1 skip (Windows-only). The new case stands a shell script that behaves like omp in for `process.execPath`, sets `PI_COMPILED=1` (which `isCompiledBinary()` honors), and waits for the entry's `argv` on the screen; with the fix reverted it fails with `entry.ts exited immediately (code 0)`.
- Not run: Windows. The new test is POSIX-only (its stand-in omp is a shell script); `Bun.which` resolves `bun.exe` there.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
