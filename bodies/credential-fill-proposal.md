## What

I'd like agents to sign in for me without ever holding my password, and today the only clean way is a JavaScript cell shaped just so, which most agents don't write.

Proposal, not built: let `fill` and `type` (browser tab, frame and element) and computer `setValue` and `type` take a secret reference in place of the text, for example `tab.fill("#password", { secret: "op://Vault/item/password" })`. omp resolves it on the host through a configured command, enters it, and never returns, prints or records the value: the status line shows the reference, and the value is registered with the secret obfuscator for the rest of the session, so a later echo (a text field in `observe()`, an error) is redacted too.

The decision for the maintainer: whether omp should own this resolution (one setting naming the command, like `!command` config values) or keep it out of core and document a cell recipe.

## Why

What a credential costs today, measured on `main` d5ac02ce867 with a scripted model driving `omp -p` against a local login page (10 runs each; every model request, session file and temp file searched for the value):

| Route | Signed in | Value in model requests | Value in session file |
|---|---|---|---|
| Registered secret placeholder (`secrets.enabled`, value in an env var from session start, bash echo shows `$$…$$`, fill with it) | 10 | 0 | 10 |
| Read inside a Python cell, `tab.fill(sel, pw)` | 10 | 0 | 10 |
| Same, computer `setValue` on a GTK field (Linux, AT-SPI) | 10 | 0 | 10 |
| Read inside a JavaScript cell, passed as a `tab.run` / `computer.run` argument | 10 / 10 | 0 | 0 |

The placeholder route keeps the value out of the model but writes it to the session file four ways (the bash result, its trace, the de-obfuscated cell code, the status line), and needs the secret present before the session starts. Status lines are fixed separately (queued fix "keep text a cell enters out of browser and computer status lines"); `sh()` output, `print`, a text field's value in `observe()`/`ax()` and screenshots stay open to any cell that holds the value.

Six blind Claude Haiku runs given a vault item and the login page: 5 signed in, 1 typed 1Password's `<concealed by 1Password>` mask into the form, 0 put the value in a model request, and 5 left it in the session file (status lines and `sh()` output).

A reference parameter removes the holding step: the cell never has the value, so none of these channels can carry it, in either language and on every browser route.

## Shape, if accepted

- Value: `{ secret: string }` wherever a fill/type text is accepted; anything else is unchanged.
- Resolution: one setting (`secrets.command`, e.g. `op read {ref}`), run on the host with the reference as an argument, never through a shell string; stdout is the value.
- Results and errors never contain it; the reference may appear.
- Prior art: a `tab.signIn` prototype (October) filled from a command source below the model and redacted it from later output; it was parked over choosing among Chrome's saved logins, which this proposal does not need.
