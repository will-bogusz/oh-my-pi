## What

If omp got killed on X11 while the computer tool was holding Shift or the mouse button, it stayed held for the whole X session and everything I typed next came out in capitals; now a small watcher process lets go for it, the same way the macOS release helper (#15192) does.

With omp SIGKILLed while holding a key, Shift or the left button, it was still down 10 of 10 times on `main` and 0 of 10 with this change, at no measurable cost per click or keystroke.

## Why

X11 takeover and `desktop` input press keys and buttons through `XTest`. Every call already releases what it pressed on success, error and cancellation, but only while omp lives: Xorg keeps an `XTest` key or button down after the client that pressed it is gone (`Xext/xtest.c` has no cleanup on client close). An omp killed mid-call (OOM, `kill -9`, a crashed Bun) left the user's own keyboard and mouse modified until they pressed and released the same key.

Releasing at the next omp start was rejected, as in #15192: the stuck key breaks the user's input now, and there may be no next run.

The session's first pressing `XTest` call `posix_spawn`s one watcher (`crates/natives/src/desktop/linux/x11/release_watcher.rs`): `/bin/sh` with its own X connection and a memfd that holds, per key and button, either an X `NoOperation` or that input's `XTest` release, armed just before omp presses it and disarmed once the server confirms omp's release. The shell waits on a socket only omp holds; when it closes, because omp died or the session ended, `cat` copies the memfd to the server. A session whose watcher cannot start within a second, or at all, runs as on `main`.

<details><summary>How the watcher works, and why it is shaped this way</summary>

- It needs `/bin/sh`, `cat` at `/bin/cat` or `/usr/bin/cat`, memfd (Linux 3.17), an omp that does not ignore SIGCHLD, a pidfd of the watcher where the kernel has them (the checked kill needs 5.4), and, with glibc before 2.34 or musl, a readable `/proc/self/fd`.
- Nothing is forked on glibc 2.24 and later or musl: `posix_spawn` does not copy omp's page tables, so the watcher costs the same at any omp size, and omp's pages are never shared copy-on-write. A watcher forked for each call, the first version of this change, cost 3 ms per call at 140 MB and 35 ms at 1.5 GB. Older glibc forks for a spawn with file actions, once per session; its vfork alternative would run omp's signal handlers in omp's own memory until the exec. memfd is created through its system call, so the release build's glibc 2.17 floor holds (its highest symbol version stays 2.17).
- Starting it (the connection, its setup, the spawn and the shell's first line) runs on the calling thread at the start of the call, under its input lease and before its focus, keyboard-grab and user-activity checks, so nothing new runs between a check and the press it guards. It connects to the peer address of the session's own X socket, so it looks no host name up, and reads the X authority file again (x11rb keeps no copy of what omp's connection used; 20 µs for a 51-entry file here), a local read no more bounded than omp's own connect's. Every wait on the server or the shell ends within one second: the connect through the socket's send timeout, which Linux applies to a connect waiting for room in the accept queue or for a TCP handshake, x11rb's polls through a deadline, and the shell's line through a read timeout reset to what is left after each signal. A start that runs out leaves no thread, socket or process behind.
- `X11Input::send_xtest`, the one path every `XTest` key and button event takes, arms a slot before the press goes out and disarms it after the release is confirmed: a one-byte `pwrite` each. A write that fails ends the watcher without sending anything, and the session runs as on `main`.
- The memfd ends with a `CreateGC` and a `KillClient` of that GC, and the watcher reads its connection until the server closes it. Xorg closes a client that hung up without reading what it had already sent: a watcher that wrote its releases and exited lost them in 6 of 250 kills here; holding the connection open, 0 of 350. The connection is blocking: x11rb makes its socket nonblocking, and `cat` gives up on a read that would block, so with Xvfb stopped for a second across the kill the releases were lost 10 of 10 times; blocking, 0 of 10.
- The watcher gets only its socket, its X connection and the memfd: the child closes every other descriptor, with glibc 2.34's `posix_spawn_file_actions_addclosefrom_np` (looked up at run time). Older glibc and musl have no such action, so there the child closes every descriptor from 4 to 64 past the highest in `/proc/self/fd`, short of the descriptor limit; one another thread opens above that during the spawn would reach the watcher, and one opened before the limit was lowered past it, which glibc refuses to close, fails the spawn instead. It has an empty environment, `cat` by absolute path (omp's `PATH` is never searched), no signal blocked, a process group of its own, and ignores SIGTERM/SIGINT/SIGHUP/SIGQUIT, so Ctrl+C, a terminal hangup or a `systemctl stop` that reaches it as well as omp still gets the releases out. Only a SIGKILL of the watcher itself, or of omp's whole cgroup, defeats it; the session's next pressing call then starts a new one. A stopped watcher counts as running: it sends nothing until it is continued.
- A session's end closes the socket and waits up to 500 ms for every process of the watcher (each holds a copy of the socket until it exits; it sends no-ops for released inputs), then kills its process group and reaps it. The watcher's pid, which is its group's id, stays its own until then because its exit leaves a zombie: an omp whose SIGCHLD reaps children at once gets no watcher. Bun and omp wait only for children they started (Bun 1.4.4 checked with pidfd, its SIGCHLD waiter thread and `--no-orphans`); a host process whose own SIGCHLD handler reaps every child could free that pid, so omp keeps a pidfd of the watcher and kills the group only while `waitid(P_PIDFD, WNOHANG | WNOWAIT)` shows it still omp's unreaped child, and reaps it through the pidfd. Kernels before 5.4, which cannot wait on a pidfd, keep the unchecked kill.

</details>

Not changed: background input (its XI2-MPX route presses through uinput devices, which the kernel removes with their fd) and Wayland.

## Testing

Xvfb on Ubuntu 24.04 (glibc 2.39); omp's own `X11Input` in a holder process on the desktop target, 10 tries per cell, read through XI2 raw events and the server's key and pointer state:

| Holder ended while holding (10 each) | `main` | This PR |
|---|---|---|
| SIGKILL during `holdKeys(["a"])`: `a` still down | 10 / 10 | 0 / 10 |
| SIGKILL during `holdKeys(["shift"])`: Shift still down | 10 / 10 | 0 / 10 |
| SIGKILL during `holdMouse`: button 1 still down | 10 / 10 | 0 / 10 |
| SIGTERM to the holder, Shift held: still down | 10 / 10 | 0 / 10 |
| SIGTERM to the holder and the watcher together, Shift held: still down | 10 / 10 | 0 / 10 |
| Xvfb stopped for 1 s across the SIGKILL, Shift held: still down | 10 / 10 | 0 / 10 |
| Watcher SIGKILLed between calls, then holder SIGKILLed holding Shift | 10 / 10 | 0 / 10 |

Every try of those cells sent exactly one release.

<details><summary>The other cells, 10 tries each</summary>

- A 300 ms `holdKeys` whose process then exits normally, and one whose process lives on and is SIGKILLed later, leave nothing down and send one release per press on both, none after the later kill.
- The release also arrives with an inheritable descriptor open in omp, with omp's stdin and stderr closed, with another thread opening descriptors while the watcher starts (also where the C library cannot close descriptors itself), and without procfs; the watcher's descriptors are its socket (0 and 4), X connection (1), `/dev/null` (2) and memfd (3) in every try.
- With the watcher killed mid-hold, with both `cat` paths hidden, with a slot write failing, with omp ignoring SIGCHLD, or with no procfs where the C library cannot close descriptors itself, the call succeeds and releases as on `main`; with the display closed mid-hold the call fails with the same `Broken pipe` as on `main` and no watcher is left running.
- A watcher that is stopped, or whose server stops reading, is killed 0.5 s into the session's end with nothing left behind. A watcher connection whose setup the server never answers, whose server's accept queue stays full, or whose shell never writes its line (also with a signal every 100 ms) costs the first call one second and leaves no thread, socket or process; the session then runs as on `main`.
- Another application grabbing the keyboard while the watcher starts gets no takeover key: the call refuses.
- Unchanged from `main`, on both: `XTest` text typed with Shift latched arrives unshifted (#19080), `xtest_text_types_through_a_neutral_keyboard_state`, `xtest_keys_refuse_another_clients_keyboard_grab`, and takeover keys reaching a focused window that grabs the keyboard on itself.

</details>

Cost per pressing call, a takeover `keyChord` on the desktop from a Bun process of each size, median of 150 calls in 3 interleaved blocks of 50 (the block-to-block spread, up to 0.05 ms, is larger than any difference):

| omp resident size | `main` | This PR |
|---|---|---|
| 143 MB | 0.42 ms | 0.42 ms |
| 632 MB | 0.45 ms | 0.43 ms |
| 1,511 MB | 0.42 ms | 0.43 ms |

The watcher is an extra X client for the session; it starts on the first pressing call (0.5 to 1 ms more on that call) and holds 1.9 MB resident, 0.2 MB proportional; omp itself grows by under 1 MB.

- The new tests pass: `cargo test -p omp-natives --lib -- --ignored killed_holder without_a_release_watcher looks_up_no_host_name` 10 of 10, and `release_watcher::tests`.
- The Linux desktop tests, ignored ones included, on Xvfb: 171 of 175 pass; the 4 failures, XI2-MPX tests that need uinput hot-plug, fail the same on `main` (164 of 168).
- The release builds `//:natives-linux-x64-baseline` (glibc 2.17 floor) and `//:natives-linux-musl-x64-baseline` build; the glibc one needs no symbol past 2.17.
- `scripts/rust-check` on Linux.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)



