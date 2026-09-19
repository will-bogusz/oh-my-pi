# vendor/cua-driver

One `manifest.json` per `<platform>-<arch>` directory names the prebuilt `cua-driver` executable OMP spawns as `cua-driver mcp --direct` for native computer control: its `version`, the fork `commit` it was built from, the `url` of the release asset holding it (a release on `github.com/will-bogusz/cua` tagged `cua-driver-<version>-<commit>`), and the `sha256` and `size` those bytes must have. The executable itself is not in git. OMP resolves it as: the installed copy in `~/.omp/natives/cua-driver/` when its manifest sha256 matches, else the download cache `~/.omp/cache/cua-driver/<sha256>/cua-driver`, else a download from `url` verified against `sha256` before it is cached and installed. Standalone builds resolve the same way at build time and embed the executable (`packages/coding-agent/scripts/cua-driver-plugin.ts`). `LICENSE-CUA.md` is the upstream license for the binary.

## Re-vendoring

`scripts/vendor-cua-driver.ts` does the whole step: build (or take `--binary`), sign on macOS, hash, publish the asset, verify the published URL serves those bytes, write the manifest, print the commit message.

```sh
git -C "$CUA_FORK" checkout <commit>
bun scripts/vendor-cua-driver.ts --commit <commit> --fork "$CUA_FORK"            # darwin-arm64, builds here
bun scripts/vendor-cua-driver.ts --commit <commit> --fork "$CUA_FORK" \
	--platform linux-x64 --binary ./cua-driver-linux-x64 \
	--source "goliath Ubuntu 24.04 glibc 2.39, cargo build --locked --release -p cua-driver --features cua-driver/portal-input"
git add vendor/cua-driver/<platform>/manifest.json && git commit -m 'chore(computer): vendor cua-driver <version> fork build (<commit>)'
```

The release is one per fork commit, one asset per platform. Re-running is idempotent: an asset that already holds the same bytes is kept; one holding different bytes is refused (a different build of the same commit needs a new tag, not a replaced asset that would break every manifest pinned to the old sha256).

## darwin-arm64 is code-signed before it is hashed

The script signs with `codesign -f -s "OMP Computer Use" --identifier com.ohmypi.cua-driver` unless the executable already carries that identity, then verifies it before hashing.

macOS TCC identifies signed code by its designated requirement — here `identifier "com.ohmypi.cua-driver" and certificate root = <the "OMP Computer Use" certificate>`. Cargo's output is ad-hoc (linker-signed), so its identity changes with every build and every build then faces a fresh Accessibility / Screen Recording prompt. A stable identifier over a stable self-signed root makes every build the same TCC client, so the grants already on the host carry over. `codesign` rewrites the file, so the manifest must describe the signed bytes, or the install refuses them; the signature lives inside the Mach-O and survives the release upload and download.

The `OMP Computer Use` identity is a self-signed code-signing certificate in the login keychain (`security find-identity -p codesigning`). It is local-only and unrelated to the release identity in `scripts/ci-macos-sign.sh`. Other platforms are vendored as built — only macOS keys permissions to code identity.
