# OMP macOS Cua SDK payload

The manifest pins the private `omp-cua-indexed-double-click-v24` payload for macOS Apple Silicon, based on Cua SDK 0.23.2. This directory contains the source patch, patch reconstruction evidence, native archive, license and installer inputs. It is not an upstream release or cross-platform qualification.

The payload includes exact PID/window and retained accessibility targeting; covered-window capture; non-activating launch; bounded accessibility walks; attached file-panel discovery; cooperative native cancellation and input-pair release; and left element double-clicks at live bounding-box centers. Labeled AX images are addressable without inventing semantic actions. Older SDKs lack the double-click capability and OMP refuses instead of silently sending AXPress once.

## Build and install

Apply `cua-sdk-omp.patch` to the exact source base and use the toolchain recorded in `manifest.json`. `patch-reproduction.json` records byte comparison of every affected source file after applying the patch to the base. Build the `cua-driver-sdk` release target from `libs/cua-driver/rust`. The archive contains the reviewed library, Node runtime, license notice and source provenance.

To regenerate the archive from the native directory whose hashes already match the manifest:

```sh
bun vendor/cua-sdk/package-artifact.ts /absolute/path/to/qualified-native-directory
```

To install the vendored artifact for source OMP:

```sh
bun packages/coding-agent/scripts/install-cua-runtime.ts
```

Standalone builds embed the archive and provision its content-addressed payload on first native use. A loaded worker keeps its existing library until release/restart. Reusing a revision with different bytes is rejected. Failed verification does not replace the prior descriptor. Use Bun 1.4.0 for this candidate; an earlier 1.3.14 capture initialization failure is recorded in the manifest.

## Qualification

V24 public-SDK and ordinary-agent trials verified an indexed image double-click at its live center, exact receiver down/up counts, fresh screenshot evidence, stale-token refusal and cleanup. The ordinary task pressed Finish once, retained its result and released control with zero tool errors. Foreground and window-order observers found no unintended changes; unattributed pointer movement prevents a general input-coexistence claim.

The source patch retains earlier scoped v23 mouse cancellation, v22 key release, and native import/export repairs. Their evidence remains attributed to the exact artifacts used. A new v24 standalone acceptance run is recorded separately in the research workspace. Passing the source or SDK trials alone does not qualify the installed user workflow.

Background drag, arbitrary native toolkits, hidden/minimized/off-Space operation, physical keyboard/pointer coexistence, and release of held input after a hard kill remain outside the demonstrated coverage. Unknown cleanup is surfaced as a failure and prevents automatic reuse; process exit alone does not prove input was released.

## License and provenance

Cua source is MIT, copyright Cua AI, Inc.; preserve `LICENSE-CUA.md`. The Node runtime derivative is MPL-2.0; preserve `node-runtime-NOTICE.md`, its source/version link and corresponding transformation source. Upstream author metadata and licenses remain intact. OMP's private patch does not claim authorship of upstream Cua or UniFFI.
