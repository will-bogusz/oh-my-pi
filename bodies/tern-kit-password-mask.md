## What

I fixed Tern's page-script observations so filling a password field doesn't send its contents back to the model.

Password values now appear as one `•` per character. Text-field values and explicit `value()` reads keep their existing behavior. This covers the page-script fallback shared by Tern and WebKit; the Tern engine's native DOM reads are outside this repository and out of scope.

## Why

An agent observing a filled sign-in form could receive the password in plain text. Related: #15502 masked password values in ARIA snapshots, but the page-script observation reader still returned the raw value.

Password masking also covers accessible names and descriptions derived from embedded fields, so Tern's `role/` selectors match those names using bullets, like Chromium. Ordinary control names and Chromium's AX-backed role selectors are unchanged. Snapshot generation already uses the masked ARIA bundle; explicit numeric ARIA values remain available without falling back to a raw password value.

## Testing

The headless Chromium regression `masks filled password values in serialized kit observations without changing text values` failed before the source fix with the raw sentinel in the observation, then the complete affected file passed: 12 tests, 0 failures.

```sh
env -u TERN_SOCKET -u CMUX_SOCKET_PATH -u TERN_PANE_SOCKET -u TERN_PANE bun test packages/coding-agent/test/tools/browser-role-ax.test.ts
```

`bun install --frozen-lockfile --ignore-scripts` passed. `bun run prepare` failed on pre-existing export-viewer metadata drift; no generated files were changed. The installed native addon reports an older version; this test exercises the serialized page script in Chromium, not native DOM reads.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (entry added under Unreleased; attribution follows PR creation)
