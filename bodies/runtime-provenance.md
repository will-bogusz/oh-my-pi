## What

I kept opening old transcripts to check whether a fix was live when they ran, and nothing in the session file says which omp build wrote it, so this records that.

Every entry an omp process writes now carries the build that wrote it. A session left open across an upgrade keeps crediting the old build until a new process writes to it, which a timestamp check against release dates gets wrong.

| Install | Recorded on each entry |
|---|---|
| Release binary, npm install, or a clean checkout of a release tag | version (the tag gives the commit) |
| Source checkout off a tag | version, commit, branch, and a hash of the uncommitted diff |
| Any, with `OMP_BUILD_LABEL` set | the above plus that label |

`/session` lists the builds in the order they wrote the session, and the running build when it differs.

Reading order:
- `session/runtime-identity.ts`: resolves the identity once per process (`currentRuntimeIdentity`) and collapses entries into build history for `/session`.
- `SessionManager.#freshEntryFields` and the few entry constructors that bypass it set `runtime`. Replicated collab entries come in through `ingestReplicatedEntry`, which does not, so they keep the host's build; oversized replication placeholders keep it too.
- `main.ts` awaits `loadRuntimeIdentity()` before the CLI creates its session, so the first entries carry the commit.

## Why

The version string can't answer the question alone: every unreleased commit and every local edit reports the same version as the last release, and a resumed session gives no sign that the code under it changed.

Decisions:
- A field on every entry, not a stamp only where the build changes. A sparse stamp has to survive every path that drops, copies or reorders entries (branch extraction, fork, atomic-batch rollback, discard, collab filtering); a review of the sparse version found it lost attribution on six of them. Per-entry copies need no handling, and the object is shared in memory. On disk it adds 32 bytes per entry for releases and about 165 for source checkouts.
- Commit, branch and diff come from the running checkout through `pi-natives/vcs`, only for source runs. Related: #8880 embeds the commit into compiled binaries, which could feed this field later; this PR leaves the build scripts alone.
- Anonymized exports have no allowlist rule for `runtime`, so it is exported as an opaque marker: branch names and labels can be private.

Non-goals: no backfill (older entries read as unknown); untracked files are not in the diff hash.

## Testing

- Live, from a dirty source checkout with Haiku 4.5: `OMP_BUILD_LABEL=variant-a omp -p …` stamped every entry with version, commit, branch, diff hash and label; `--resume` under `variant-b` stamped only the new entries `variant-b`. `/session` in the TUI then listed variant-a → b → c.
- `test/session-manager/runtime-identity.test.ts`: resume by another build, branched-session copies, and collab ingest each keep the original writer.
- 403 test files touching sessions: same 48 failures as `main` at the same commit (LSP mux, worker processes, browser relay; environment), none new. `bun run check:ts` clean.
- Not run: a compiled binary or a clean release-tag checkout (the version-only branch).

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
