## What

`power.sleepPrevention` quietly stopped doing anything on main because the new default `start` calls `PowerAssertion.start` without its class, so I made it call through the class again.

A turn on `main` now holds no sleep assertion on any platform; with this fix it holds the four `power.sleepPrevention: system` asks for again and releases them when the turn ends. Unreleased: v18.11.1 is not affected.

- `startPowerAssertion`'s default is now `options => PowerAssertion.start(options)` instead of the bare `PowerAssertion.start`.
- A new test spies on `PowerAssertion.start` and checks the default calls it with `PowerAssertion` as `this`.

## Why

napi-rs class statics read their class from `this`. The default parameter added in "log missing power assertion backend once at debug instead of warning every turn" passes the static as a plain function value, so every call throws ``Failed to create instance of class `start` ``. `startPowerAssertion` catches that, warns, and returns `undefined`, so the session runs every turn without an assertion. The existing tests all pass their own `start`, so none of them reached the default.

The other places that hand a napi static around (`IpcConnection.connect`, `Process.fromPid` in tests) already `.bind` it; nothing else in `packages/` passes one unbound.

## Testing

Live on macOS with the worktree's own natives addon built from this branch's base and `power.sleepPrevention: system`, `pmset -g assertions` sampled every second for the `omp -p` process's pid during a turn that runs `sleep 12`:

| | Assertions held by the `omp -p` pid during the turn | After exit |
|---|---|---|
| `main` | 0 at every sample | 0 |
| this PR | 4 from the 2nd second on (`PreventUserIdleSystemSleep`, `PreventUserIdleDisplaySleep`, `PreventSystemSleep`, `UserIsActive`, named "omp agent session") | 0 |

Calling `startPowerAssertion({ reason, idle, display, system, user })` directly returned `undefined` on `main` and a `PowerAssertion` here.

`bun test packages/coding-agent/test/power-assertion-options.test.ts`: 6 pass here; on `main` the new test fails with `Expected: [class PowerAssertion] Received: undefined` (5 pass, 1 fail). The spy replaces the native call, so the test needs no macOS, D-Bus or Windows backend. The Linux and Windows backends were not run live; the throw happens in the napi binding before any backend code.

Type checks of every package pass; root `bun run check:ts` stops on a formatting issue `main` already has in `packages/coding-agent/test/discovery/builtin-hooks.test.ts`, which this PR does not touch.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
