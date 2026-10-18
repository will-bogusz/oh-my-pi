## What

When the agent's double click gets stopped because I clicked into its app, the error should say the first click may already have landed, not just keys, so I fixed that wording and added the missing test for `el.type`.

Since #15562, a left click, and any takeover click, stops at the user's first key or click in its app, the same way keys do; a background right or middle click checks only before it starts. A multi-click can therefore stop after its first click, and the background click's key-making press always goes out before the check. The `UserIntervened` error from that stop now says "input sent before that may already have landed" instead of "keys". The docs say the same, and `docs/tools/computer.md` now lists `el.type` among the element calls that wait for the user to pause.

`el.type` and `el.press` (`Request::AxInput`) were already admitted on `main`, but no test covered it. `the_focused_elements_app_is_watched_from_the_read_that_found_it` now also checks that typing into a focused element of an app the user just used returns `UserIntervened` from the pause wait.

## Why

Follow-up to #15562. The agent reads this message to decide what to re-check. "Keys" told it nothing about a click that already landed.

## Testing

On bench-mac: `cargo check -p pi-natives --tests`, `CI=1 bun check` (which runs clippy) and `cargo test -p pi-natives --lib` (888 tests) pass with this branch merged with the other open computer-use PRs (#16185, #16188, #16200 and two queued follow-ups). With `AxInput` removed from the watch's `app_access`, the extended test fails.

`UserIntervened` is unreleased, so no CHANGELOG line; its `[Unreleased]` entry already says keys and clicks stop.

