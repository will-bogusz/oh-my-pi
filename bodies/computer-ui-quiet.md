## What

I kept seeing new Finder folders stay "untitled folder" because the agent typed the name before Finder had the name field up, so now reads and input wait until the app is done reacting to the input before them.

In a scripted Finder cell (new folder, type its name, Return), the folder is named right 60/70 → 70/70 times, and the cell takes 0.58 → 1.42 s.

| Finder new-folder cell: named right, cell median | main | this PR |
|---|---|---|
| Warm guests, 7 sessions per arm (earlier build, below) | 60/70, 0.58 s | 70/70, 1.42 s |
| Guest booted about 5 min before, 4 sessions per arm (this head) | 21/40, 0.57 s | 40/40, 1.43 s |

**Cost:** on macOS each read or input within 5 s of earlier input waits at least 250 ms, longer while the app keeps changing.

Reading order: `crates/pi-natives/src/desktop/macos/settle.rs` `wait_for_quiet`, then `worker.ts` `InputObserver.input`, `settle`, `#restore`; `observation.ts` maps refs and points to windows.

## Why

On `main` no call waits for the app to finish reacting to the one before, so it can land while the app is still opening a sheet, a popover, a rename field or a window.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/3f665448-7f4a-490b-850b-91057303eba3">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/9856fa1e-0459-4051-8359-2a4dc828aa2c">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/7e6f6c9b-e9c0-4b3a-8dcc-7165c1981cc3">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/7881b903-1bef-463a-8e7b-7901beed7637">
  <img width="780" alt="Timeline of a Finder new-folder cell. main: after cmd+shift+n the name is typed at once, while Finder is still opening the name field, and the folder can stay &quot;untitled folder&quot;. This PR: the typing waits until Finder sends no accessibility notification for 250 ms, then the folder gets its name." src="https://github.com/user-attachments/assets/9856fa1e-0459-4051-8359-2a4dc828aa2c" />
</picture>

Quiet means 250 ms without an accessibility notification (focus, layout, windows or sheets created) from the apps that input reached, 5 s at most. Value changes don't count: carets and clocks send them forever.

- Every app earlier input reached is waited for, not only the next input's: scoping it per app (tried first) let a paste go out before its copy settled.
- A cancelled wait leaves its input owed, rather than settled, so the next call still waits.
- Input that ended 5 s ago or more owes nothing, rather than a wait that gives the app no more time than it had; across a model turn this is usually the case.
- A call refused before anything was sent owes nothing.
- A desktop key also owes the app focused after it (`cmd+tab`, Spotlight), for one window list per key.
- Two cost cuts lost names on a 2026-10-13 build: counting quiet from the input (0.07 s faster, 38/40) and keeping observers registered (0.03 s, 39/40).

Linux and Windows can't watch notifications and wait a fixed half second after input. Chrome sends nothing while a page loads over the network, so a read can still predate a load. Maintenance: `NOTIFICATIONS` in `settle.rs`; an app that never goes quiet costs each wait the 5 s cap.

## Testing

- Live, guest macOS VM, no model: the table above, 10 cells per session, the two arms' sessions interleaved. Every miss on `main` left the folder "untitled folder", none of the name in it.
- Dev set, guest macOS VM, GPT-6.1 Sol (medium), 4 tasks × 3 runs per build, all passed: on the long Automator task this PR used fewer tokens in every run (0.85–1.07M against 1.15–1.59M on `main`), steps overlapping (30–36 against 36–45); three short tasks showed no clear change.
- `bun test test/tools/computer.test.ts -t "waits for the UI to settle"`: 15 pass; each rule, reverted alone, fails its own tests (10 reverts, below).
- bench-mac: `bun check` exit 0, Rust tests 905 pass / 0 fail, native build exit 0.
- Not run: Linux and Windows (fixed wait, unit-tested only).

<details><summary>Builds, per-session counts, revert checks</summary>

Warm rows ran bcc436213d; this head adds the overlap, desktop-key, `menu.items` and refused-call fixes, which in this cell add one window list after each key and no new app, so they can't change the names; the head's own sessions show the same cost. Named right per session, `main`: 8, 10, 10, 9, 10, 3, 10 (warm) and 5, 4, 10, 2 (fresh boot; Finder drops more keys right after boot). This PR: 10 in every session. Cell: `await computer.press("cmd+shift+n"); await computer.type("probe-folder-N"); await computer.press("return")`, then the folder is listed.

Failing tests per revert: no wait before input 3; no 5 s drop 1; no `#restore` 1; an input overlapping a read 1; a desktop key's activated app 2; pointer input's app under the pointer 2; `apps.open`'s app 1; `menu.items` as input 1; a call refused before sending waiting 1; one refused by native 1.

</details>

<details><summary>Dev set: every run (n = 3 runs per task per build)</summary>

| task | `main` c6ec2ff47a | this PR ee94355b9c (code = head) |
|---|---|---|
| Finder: sort files into three new folders | 3/3 pass; steps 21, 16, 14; tokens 0.32, 0.29, 0.24M; context peak 26, 23, 24k | 3/3 pass; steps 11, 14, 14; tokens 0.19, 0.23, 0.26M; context peak 22, 23, 26k |
| Automator: build and run a workflow (long) | 3/3 pass; steps 36, 45, 38; tokens 1.17, 1.59, 1.15M; context peak 47, 52, 44k | 3/3 pass; steps 30, 36, 34; tokens 0.85, 1.07, 1.03M; context peak 41, 48, 47k |
| Font Book: make a font collection | 3/3 pass; steps 14, 15, 15; tokens 0.27, 0.27, 0.27M; context peak 25, 21, 21k | 3/3 pass; steps 11, 15, 14; tokens 0.21, 0.29, 0.24M; context peak 22, 23, 20k |
| Calendar: add a recurring event | 3/3 pass; steps 24, 18, 16; tokens 0.58, 0.43, 0.42M; context peak 30, 31, 37k | 3/3 pass; steps 22, 17, 27; tokens 0.43, 0.39, 0.72M; context peak 30, 28, 35k |

Against `main`, geometric mean over the 4 tasks of each task's median of 3 runs (n = 3 runs per task per build): this PR: steps 0.97×, tokens 0.89×, context peak 0.99×. Run-to-run spread is wide (`main`'s Finder runs took 21, 16 and 14 steps), so these means say little beyond the Automator task. Runs Codex refused before their first step are left out.

</details>

---
- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
