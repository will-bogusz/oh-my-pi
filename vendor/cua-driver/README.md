# vendor/cua-driver

Prebuilt `cua-driver` executables, one per `<platform>-<arch>` directory, spawned by OMP as `cua-driver mcp --direct` for native computer control. `manifest.json` records the version, the sha256 of the executable, its source (upstream release or fork commit) and its size in bytes. OMP verifies that sha256 and installs the executable as `~/.omp/natives/cua-driver/cua-driver` on first use (and again whenever the manifest changes); nothing is downloaded. `LICENSE-CUA.md` is the upstream license for the binary.

## Producing a build

From a checkout of the fork (`github.com/will-bogusz/cua`, branch `will/omp`), with `$OMP` the OMP checkout:

```sh
cargo build --locked --release -p cua-driver
cp libs/cua-driver/rust/target/release/cua-driver "$OMP/vendor/cua-driver/darwin-arm64/cua-driver"
```

### darwin-arm64 must be code-signed before it is hashed

```sh
codesign -f -s "OMP Computer Use" --identifier com.ohmypi.cua-driver \
	"$OMP/vendor/cua-driver/darwin-arm64/cua-driver"
codesign --verify --strict "$OMP/vendor/cua-driver/darwin-arm64/cua-driver"
```

macOS TCC identifies signed code by its designated requirement — here `identifier "com.ohmypi.cua-driver" and certificate root = <the "OMP Computer Use" certificate>`. Cargo's output is ad-hoc (linker-signed), so its identity changes with every build and every build then faces a fresh Accessibility / Screen Recording prompt. A stable identifier over a stable self-signed root makes every build the same TCC client, so the grants already on the host carry over. `codesign` rewrites the file, so sign first and only then take the sha256 and byte count for `manifest.json`: the manifest must describe the signed bytes OMP installs, or the install refuses them. Name the signing step in `manifest.json`'s `source` next to the build command.

The `OMP Computer Use` identity is a self-signed code-signing certificate in the login keychain (`security find-identity -p codesigning`). It is local-only and unrelated to the release identity in `scripts/ci-macos-sign.sh`. Other platforms are vendored as built — only macOS keys permissions to code identity.
