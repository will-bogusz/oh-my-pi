## What

My eval kernel runs in a venv I made with `uv venv`, and every `%pip install` there failed with "No module named pip", so I made the magic install through uv, or bootstrap pip, when the interpreter has none.

`%pip install six` against a pip-less venv: `No module named pip` → `+ six==1.17.0`, installed into the kernel's interpreter.

| Kernel interpreter | `main` | This PR |
|---|---|---|
| Has pip | `python -m pip <args>` | unchanged |
| No pip, `uv` on `PATH`, subcommand uv has (`install`, `uninstall`, `list`, `freeze`, `show`, `check`) | fails: `No module named pip` | `uv pip <args>` with `UV_PYTHON` set to the kernel's interpreter |
| No pip, anything else (no `uv`, `--version`, `download`, `wheel`) | fails: `No module named pip` | `python -m ensurepip`, then `python -m pip <args>` |

On the uv route, uv's ` + name==version` lines fill the `pip` status event's installed list and evict those modules from `sys.modules`, as pip's `Successfully installed` line does.

**Beyond the fix:** cancelling a `%pip` cell now kills the installer child (pip, uv or ensurepip). On `main` the SIGINT reached only the kernel, so pip kept writing into the env after the cell reported cancelled; the new children share that helper. Exempting pip is one branch.

## Why

`uv venv` creates environments without pip, and `python.interpreter` (or a project `.venv`) often points at one. The eval prompt tells the model to fix a missing import with `%pip install`, so in those kernels the documented path fails every time and the model falls back to shelling out.

Decisions:
- `UV_PYTHON` rather than a `--python` flag: uv accepts `--python` only after the `pip` subcommand, so the env var targets the interpreter without parsing the user's arguments. It also wins over an inherited `VIRTUAL_ENV`.
- pip-only flags with no uv meaning (`--disable-pip-version-check`, `--no-input`, `--no-warn-script-location`) are dropped on the uv route, since uv rejects them. Other flags uv rejects (`--user`, `--progress-bar`) fail with uv's own error.
- The pip check is `importlib.util.find_spec("pip")` in the kernel after `invalidate_caches()`, so a pip that `ensurepip` installed earlier in the same kernel is found next time. A failed `ensurepip` (some distro Pythons drop it) prints its error and reports its exit code.

Maintenance: if uv adds or drops a `uv pip` subcommand, `_UV_PIP_SUBCOMMANDS` in `runner.py` is the one list to change.

## Testing

- Live: `bun packages/coding-agent/src/cli.ts -p --model anthropic/claude-haiku-5-5 --config overlay.yml`, with `python.interpreter` set to a fresh `uv venv`, asked for one eval of `%pip install six`. `main` printed `No module named pip`; this branch printed uv's install lines and `venv/bin/python -c "import six"` worked.
- `PI_PYTHON_INTEGRATION=1 bun test test/core/python-runner.integration.test.ts -t "pip"` (packages/coding-agent), on `python -m venv --without-pip` venvs, 3 new cases: a recording `uv` on `PATH` gets `pip install six` with `UV_PYTHON` at the kernel's interpreter, the status event lists `six`, and `%pip --version` never reaches uv; cancelling a cell whose `uv` sleeps leaves no uv process; with `uv` off `PATH`, `%pip --version` succeeds after `ensurepip`. With `runner.py` reverted to `main`, all 3 fail.
- `bun run check` in packages/coding-agent passes.

Not run: Windows (the new tests skip there; the code uses `shutil.which` and `sys.executable`, no POSIX-only calls).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
