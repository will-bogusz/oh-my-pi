## What

I kept hitting `find` on `ssh://` paths and getting an approval error that no approval could ever clear, so this gives `find`, `glob` and `ast_grep` the same per-path approval `grep` already has.

An `ssh://` path in these tools now asks for `exec` approval and then runs, as `read` and `grep` do. Local and other internal-URL paths stay `read`.

| Call on an `ssh://` file | `main` | This PR |
|---|---|---|
| `find` | `ssh:// access needs exec approval; this command was approved at read` | asks for `exec` approval, then searches the remote file |
| `glob` | `Cannot glob ssh://…: ssh:// access needs exec approval; …` | same as `find` |
| `ast_grep` | `Cannot search ssh://…: ssh:// access needs exec approval; …` | same as `find` |

## Why

`ssh://` declares `readTier: "exec"`, and the URL filesystem refuses a scheme whose read tier is above the tier its tool was approved at. `read` and `grep` derive their tier from the path (`InternalUrlRouter.readTier()`). `find`, `glob` and `ast_grep` declared a fixed `approval = "read"` and built their filesystem at that tier, so every `ssh://` call failed after approval, naming an approval the user is never asked for.

`grep`'s inline approval function moves to `searchPathTier()` in `tools/path-utils.ts`, and all four search tools use it. `find` now builds its filesystem from `resolveToolTier(this, params)`, as `glob` and `ast_grep` already did. An `ssh://` path still reaches no handler, and opens no connection, until the call passes the `exec` gate. The filesystem's tier check is unchanged.

**Non-goal:** remote `ssh://` directories. The URL filesystem lists them only through `read`, so a directory scope still fails here as it does in `grep`. Listing remote directories for a recursive walk is a separate change.

## Testing

- `ssh-url-approval.test.ts`: `find`, `glob` and `ast_grep` resolve `exec` for `ssh://icaro/etc` and `src,ssh://icaro/etc`, and `read` for `src` and an omitted path.
- `ssh-url-approval-gate.test.ts`: through the production approval wrapper in `always-ask` mode, `glob` on `ssh://localhost/etc` is refused at the gate and a local `*.txt` glob runs. This replaces the ungated test that expected `glob` to reject `ssh://` itself.
- Negative control: with `src/` reverted, those 4 tests fail. The gate test gets `main`'s `Cannot glob … approved at read`.
- Live (`omp -p`, Claude Haiku 5.5, macOS to a Linux host): `find` on a remote file returned the error above on `main`, and `1 hit(s) … 0.97` on this branch. `ast_grep` on a remote `.py` file returned matches, and `glob` on a remote file returned its URL.

```
bun test test/tools/ssh-url-approval.test.ts test/tools/ssh-url-ungated-tools.test.ts test/tools/ssh-url-approval-gate.test.ts
```

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
