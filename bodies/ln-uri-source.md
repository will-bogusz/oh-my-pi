## What

When I linked a file from `local://` into the project with `ln -s`, the link held the text `local://…` and nothing could open it, so a host symlink to a file-backed URL now stores the path of the file the URL stands for.

`printf 'body\n' > local://source.txt && ln -s local://source.txt host-link && readlink host-link && cat host-link` through the bash tool:

```text
main                                            this PR
local://source.txt                              /tmp/…/local/source.txt
cat: host-link: No such file or directory       body
```

A link created inside a URL filesystem (`ln -s local://a local://link`) still stores `local://a`, and a URL that aliases no file (`omp://`, `history://`) is still stored as written.

## Why

The operating system follows a host symlink, and it cannot read a URL, so a host link holding `local://source.txt` dangles for every program, the shell's own `cat` included. `ln` deliberately stored its source verbatim, which is right for links between host paths and for links inside a URL filesystem, whose provider resolves URL text. For the mixed case the shell already knows the answer: `realpath` and `readlink` print a backed URL's file through `backing_path`, and external commands receive that file since `59f246a43a`. `ln` now uses the same lookup when the link is symbolic, its source is a URL and its destination resolves to a host path. `ln -sr` computes the relative path from that file. On Windows the link kind (file or directory) is now chosen from the target itself, not from the `-r` text, which `main` resolved against the shell's directory instead of the link's, giving a directory a file link.

Non-goal: rewriting existing links.

## Testing

- `host_symlinks_to_backed_urls_store_the_backing_path` (`pi-shell/tests/vfs.rs`, a provider that backs `virtual://` with a temp dir): a host link stores the backing file and reads its content; a missing URL target stores the path it would have; `ln -sr` stores a relative path that reads the content; a URL that aliases nothing keeps its text. On `main` it fails with `virtual://target` stored.
- `links a host path to the file a backed URL aliases` (`coding-agent/test/tools/bash-url-filesystem.test.ts`) runs the command above through `BashTool` on the real `local://` filesystem. With natives built from `main` it fails (8 pass, 1 fail); built from this branch, the file passes (9 of 9), including the existing test that a link inside `local://` keeps `local://source.txt`.
- `cargo test -p pi-shell --test vfs` (14) and `cargo test -p pi-builtins --lib ln::` (11) pass.
- Not run: Windows. `relative_symlink_to_directory_from_another_directory_is_a_directory_link` covers the link kind there (`ln -sr dir sub/link`, then reading `sub/link/file`).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
