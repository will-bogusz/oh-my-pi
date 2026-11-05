## What

An agent ran `gh issue list --search "skill:// external command"` and the whole command died with exit 126, because the shell tried to open that search text as a skill file, so I made the shell treat a scheme followed by words as text, the way it already treats a bare `local://`.

The bash tool hands an external command the file behind each internal-URL argument (`python skill://x/tool.py`). A bare scheme root is kept literal because it is "far likelier a search pattern or message text" (`host_arg` in `crates/pi-shell/src/host/urls.rs`). A root followed by whitespace is the same kind of text, but it went through resolution:

| Argument to an external command | `main` | This PR |
|---|---|---|
| `"skill:// external command"` | `cannot resolve skill:// external command for an external command: No such file or directory`, exit 126, the command never runs | reaches the command as written |
| `"local:// some words"` | rewritten to `<local root>/ some words` | as written |
| `--search="skill:// words"` | same as the bare form | as written |
| `local://`, `skill://x/tool.py`, `https://…` | unchanged | unchanged |

`is_url_root` becomes `names_nothing`: after `scheme://` and any extra slashes, nothing left, or whitespace first. Both spellings `host_arg` translates (bare and `--opt=value`) use it. No skill name or file under a URL root starts with a space, so nothing that resolves today stops resolving.

## Why

An agent searches issues, greps logs or writes commit messages that mention these schemes, and the space after `://` is where the words start. Failing the command there blocks it outright, and the `local://` rewrite is worse: the child gets a path it was never asked for, with no error.

Non-goal: a URL the provider rejects (an unknown skill, a path escaping its root) still fails the command, as `20a0b853137` decided. So `omp read skill://<skill installed after the session started>` from bash still fails on the session's stale skill list; that is the skill list's freshness, not argument translation.

Related: #14838 (introduced argument translation).

## Testing

`crates/pi-shell/tests/vfs.rs` `external_commands_receive_host_paths_for_backed_url_arguments` gains `'virtual:// external command'` and `'--search=virtual:// words'`. On Linux (goliath):

- `urls.rs` reverted to `main`: fails, the child printed `/tmp/.tmpKvIHO0/ external command` and `--search=/tmp/.tmpKvIHO0/ words`.
- With the fix: `cargo test -p pi-shell --test vfs`, 17 passed.

Live through the real `BashTool` and `InternalUrlFilesystem` (no skills loaded), with an addon built from `main` and one from this branch:

| Command | `main` addon | Branch addon |
|---|---|---|
| `/bin/echo "skill:// external command"` | exit 126, `cannot resolve` | `skill:// external command` |
| `/bin/echo "local:// some words"` | `/tmp/live-url-irUAMC/local/ some words` | `local:// some words` |
| `/bin/echo --search="skill:// words"` | exit 126 | `--search=skill:// words` |
| `/bin/echo skill://missing-skill/x` | exit 126 | exit 126 (unchanged) |

`test/tools/bash-url-filesystem.test.ts` passes on the branch addon (11/11). `cargo test -p pi-shell --lib` has the same 25 zsh-module failures with and without this change on goliath; none touch URL arguments.

Re-run: `cargo test -p pi-shell --test vfs external_commands_`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution
