## What

I regenerated the export viewer metadata because main's CI has been failing at `bun install` since the artifact:// fold landed.

This commits `bun --cwd=packages/collab-web run gen:export-viewer --write` output for current `main`: three lines of `packages/coding-agent/src/export/html/viewer.generated.json` change (bundle file hash, integrity, size 793809 → 794457). No code or behavior changes.

## Why

b2795320363 (`feat(coding-agent)!: folded artifact:// spills into local://`, 13:04Z on 2026-11-18) changed the export viewer's sources without regenerating its metadata. The root `prepare` script runs `gen:export-viewer` in check mode, so `bun install` exits with "Export viewer metadata is stale" in every CI job on `main` and on every open PR since then. The last green CI on `main` was e1ae2cc998.

No CHANGELOG entry: nothing a user sees changes, same as the earlier regenerations (9303ceac22a, 3085b52e1af, 90751af0f73).

## Testing

- On `main` (2cdc756f931), `bun run gen:export-viewer` fails with the stale-metadata error; on this branch it passes, and the whole root `bun run prepare` exits 0.
- Running the `--write` generator twice gives byte-identical output.
- This PR's CI gets `bun install` past `prepare`.

---

- [x] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
