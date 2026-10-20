## What

The bash tool's `rg` came back empty when I pointed it at `/tmp` or a symlinked skill folder, while real ripgrep found the files, so `rg` and `fd` now walk a path that is a symlink to a directory, as ripgrep and fd do.

On macOS, `rg -l localhost /etc` through the bash tool printed nothing and exited 1; it now lists `/etc/hosts` and the rest, like `/opt/homebrew/bin/rg`.

| Command, `link -> real` | `main` | this PR | ripgrep 15 / fd 10.5 |
|---|---|---|---|
| `rg -l hit link` | nothing, exit 1 | `link/a.txt`, `link/sub/b.txt` | same |
| `rg -l --no-follow hit link` | nothing, exit 1 | the two files | same |
| `fd . link` | `link` | `link/a.txt`, `link/sub` | same |
| `rg -l hit parent` (holds a link to `real`) | nothing | nothing | nothing |

Links met during the walk are still left alone unless `-L` is given.

## Why

Both builtins walked their path operands with `FollowLinks::Never` unless `-L` was set, so an operand that is itself a symlink had nothing under it to walk. On macOS `/tmp`, `/etc` and `/var` are such links, and agents search symlinked config folders (skills, rules, extensions) often. ripgrep follows a symlinked path operand even with `--no-follow` (verified with ripgrep 15.2), and fd walks it too; the walker already has `FollowLinks::Roots` for exactly this, which `grep -r` uses. In my sessions since 2026-09-15, 13 builtin `rg` runs had a symlinked directory as an operand, 5 of them `/tmp`.

The `bool -> FollowLinks` conversion mapped `false` to `Never`; rg and fd were its only users, so it is removed rather than left to repeat this.

Related: #16562 fixes the same root-symlink miss in the `grep` tool's native search.

## Testing

- `follows_a_symlinked_root_operand_but_not_nested_links` (`rg.rs`) and `walks_a_symlinked_root_operand_but_not_nested_links` (`fd.rs`) build the table's tree and check each row, including `-L` entering the nested link; they pass on Linux and macOS. With `Never` restored, both fail: rg returns `(1, [])`, fd returns `["link"]`.
- Through the bash tool on macOS before the fix: `rg -l localhost /etc` empty, `/opt/homebrew/bin/rg -l localhost /etc` lists `/etc/hosts`.
- `cargo test -p pi-builtins --lib` and `cargo test -p pi-walker` pass on Linux; `rust-check` clippy and rustfmt pass on Linux, Windows and macOS. Also checked unchanged: file and symlink-to-file operands, `-` stdin, `--one-file-system` through a link to another device, rg skipping its own output file, and fd's `--no-follow`/`-L` ordering.
- Not run: Windows. There the walker's directory listing opens a directory with `FILE_FLAG_OPEN_REPARSE_POINT`, so a linked root still lists nothing, as `-L` already does on `main`; that is a walker fix of its own and not one I can test here.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
