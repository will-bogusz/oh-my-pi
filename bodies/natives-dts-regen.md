## What

Every `bun run build:native` on `main` left `packages/natives/native/index.d.ts` modified, so I regenerated it: the committed file now matches what the build writes, and a native build leaves the tree clean.

The drift is 29 lines in one file:
- `closeDesktopEventTaps`: its doc comment still had the old text after the Rust doc in `crates/pi-natives/src/desktop/mod.rs` was reworded (83cc2a3472).
- `desktopEscapeStops` and `parseCodeStatus`: inserted by hand out of the generator's order; `@napi-rs/cli`'s name sort places them elsewhere.

No declaration is added or removed, and `index.js` regenerates byte-identical.

## Why

`packages/natives/scripts/build-bindings.ts` installs the generated `index.d.ts` on every local build, and nothing in CI compares it with the committed copy. Until the copy matches, every contributor who builds natives gets a dirty tree, and a hand-edit in a later merge can drift it further.

## Testing

- `bun run build:native` on `origin/main` 9d5d4ac5b5, macOS arm64: the only change is this file.
- The same build on Linux x64 (`linux-x64-modern`) gives a byte-identical `index.d.ts` and `index.js`, so the order is not platform-dependent. No exported item sits behind a platform `cfg`.
- The text equals `@napi-rs/cli` 3.7.2's typegen plus `scripts/gen-enums.ts` over the build's type-def output, under several locales.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
