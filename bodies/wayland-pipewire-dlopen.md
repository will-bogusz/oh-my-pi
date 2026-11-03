## What

Released builds couldn't take a single Wayland screenshot because the pipewire crate has to link libpipewire at build time, so I moved the one frame grab onto a runtime `dlopen` of libpipewire, the way verusferro proposed in #9385.

On GNOME 50 and KDE Plasma 6.8, the released 18.16.0 addon fails every screenshot and every click, drag and scroll; the cargo build of this branch, with no Cargo features, captures in 110–330 ms, and those actions land.

| | 18.16.0 release addon | This PR, no Cargo features |
|---|---|---|
| `capabilities().capture` | `false` (`capturePermission: "unavailable"`) | `true` (`prompt-or-granted`) |
| `computer.screenshot()` | `CaptureFailed: Wayland capture requires the wayland-pipewire feature` | correct desktop image; GNOME 113–203 ms, KDE 310–332 ms after the first shot |
| `click` / `drag` / `scroll` | `InvalidCoordinateFrame: no capture of 'desktop' yet` | act (text read back in Testing) |
| Host without libpipewire | addon loads, `capture: false` | addon loads, `capture: false`; screenshot fails with `… libpipewire-0.3.so.0 could not be loaded (<dlerror>)` |

> **Wayland capture context.** OMP asks the ScreenCast portal for a stream through `ashpd` (pure Rust, unchanged). The portal hands back a PipeWire node and socket; only `grab_pipewire_frame`, which pulls one frame from it, needed libpipewire.

<details><summary>Reading order</summary>

- `wayland/pipewire.rs`: the 15 `pw_*` functions, resolved once per process (`library()`); the leading fields of the C structs read; the `EnumFormat` POD encoder (`enum_format`) and the negotiated-format decoder (`parse_video_format`).
- `wayland/capture.rs`: `grab_pipewire_frame` over that table; `Connection` destroys the objects in reverse order; `rgba_from_buffer` keeps its stride and format handling.
- `wayland/mod.rs`: the backend holds the load result, which `capabilities()`, `capture()` and `validate_frame_layout()` read instead of `wayland-pipewire` cfg gates.
- Build: the feature, the optional `pipewire` dependency and `OMP_NATIVE_FEATURES` (it only passed that feature) are removed; `MODULE.bazel.lock` takes the new `Cargo.lock` hash; Nix's `withWaylandScreencast` now puts pipewire on the addon RUNPATH, as it already does for libpulse.

</details>

## Why

Closes #9385. Related: #9935 (its capture part), #13845 (multi-monitor capture).

Release builds use `crate_features = []` because the `pipewire` crate links libpipewire-0.3 through pkg-config, which musl and arm64 cross builds can't satisfy, and a linked addon would not load on hosts without it.

- **`dlopen` over a second `-pipewire` addon:** one artifact and no loader choice. WebRTC loads PipeWire this way by default ([`rtc_link_pipewire = false`](https://webrtc.googlesource.com/src/+/refs/heads/main/webrtc.gni)).
- **`libc::dlopen` over `libloading`:** pi-voice already loads libpulse and libasound this way.
- **Not the Screenshot portal:** it gives no stream geometry, which every coordinate action re-validates.

Maintenance: the 0.3 client ABI has been stable since 2020 and 1.x keeps the `libpipewire-0.3.so.0` soname. If a release ever drops it or a symbol, `capture` turns `false` and the error names what is missing; the fix is one constant or signature.

Non-goals: several monitors (#13845); wlroots/Hyprland portals that send frames only on damage (unchanged).

## Testing

KVM guests, Fedora 44, 1280×800, PipeWire 1.6.11, driven through `AgentSession` → eval → `computer`. Addon from `bun --cwd=packages/natives run build` with no `OMP_NATIVE_FEATURES`; `readelf -d` lists no libpipewire. The release addon failed as in the table on both desktops.

- **GNOME 50.6:** in gedit, click+type gave `row 1!`, three drags selected `alpha bet`, `second li` and `pha beta ga` (read back through the clipboard), scroll dy 10 put line 39 on top. A `--features wayland-pipewire` build of `main` read back the same.
- **KDE 6.8.2:** in Kate, click gave `row 1!`, a drag replaced line 2, scroll put line 31 on top.
- **No libpipewire** (`/dev/null` bound over it in the probe's mount namespace): `capture: false` on both, screenshots fail naming the library, the process stays up.
- `cargo test -p pi-natives --lib -- desktop::linux`: 62 pass; with the decoder's bounds checks reverted, the short-property case fails. `bun run check:ts`: oxlint and every type check pass; oxfmt flags two files this PR doesn't touch, as on `main`.

<details><summary>Details and unit tests</summary>

- GNOME screenshots 194/114/125 ms; with the restore token deleted, the first one waits on the "Share Screen" dialog (11.4 s), later ones 194/203 ms. KDE 828/310/332 ms, run on the build before the review fixes (bounds checks in `parse_video_format`; the KWin bytes it decoded are the unit test's fixture).
- No-library error: `CaptureFailed: Wayland capture needs PipeWire's client library: libpipewire-0.3.so.0 could not be loaded (/lib64/libpipewire-0.3.so.0: file too short)`, in 1–40 ms.
- `enum_format_matches_the_pipewire_builder`: our 184 bytes equal pipewire-rs 0.9.2's `PodSerializer` and libspa's `spa_pod_builder_add_object` for the object `main` sent.
- `video_format_reads_negotiated_compositor_formats`: the `Format` params mutter and KWin negotiated, captured live, decode to BGRx 1280×800 as libspa's `spa_format_video_raw_parse` reads them; a truncated param, or a property too short for its value, decodes to nothing.
- `missing_library_names_the_soname`, `capabilities_report_no_capture_without_libpipewire`: a failed `dlopen` gives `capture: false` and a `CaptureFailed` naming the library.
- Not run: Bazel release addons (linux-arm64, musl) were not built, though `pipewire.rs` passes `cargo check` for aarch64-gnu, aarch64-musl and x86_64-musl; and no Nix build with `withWaylandScreencast = true` (no nix host).

</details>

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
