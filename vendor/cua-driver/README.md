# vendor/cua-driver

Prebuilt `cua-driver` executables, one per `<platform>-<arch>` directory, spawned by OMP as `cua-driver mcp --direct` for native computer control. `manifest.json` records the version, the sha256 of the executable, and its source (upstream release or fork commit). OMP installs the executable into `~/.omp/natives/cua-driver/<sha256>/` on first use; nothing is downloaded. `LICENSE-CUA.md` is the upstream license for the binary.
