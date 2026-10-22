## What

When I click into the app while the agent's background right or middle double click is running, the second click should not go out, the same as a left click. Each press of a background right or middle click now checks the user's input first, and a stop after the first press says that input may already have landed.

Before, a background right or middle click checked once, before its hover. A key or click of the user's between presses let the remaining presses through, while left and takeover clicks stopped.

## Why

Follow-up to #15562 and #16206, found in #16206's review. The agent re-reads the window after `UserIntervened`; a second right click over the user's input defeats that.

## Testing

On bench-mac at this head: `CI=1 bun check` (which runs clippy) passes, and `cargo test -p pi-natives --lib` passes 931/931. Before the rebase onto `main`: with only the first press checked and every check reporting nothing sent, `a_background_right_double_click_stops_at_the_users_input_after_its_first_click` and `a_right_click_stopped_after_its_first_press_says_that_press_may_have_landed` fail.

`UserIntervened` shipped in 18.12.2, so the natives CHANGELOG gets a Fixed line, and `docs/computer-use.md` and `docs/tools/computer.md` no longer say a background right or middle click checks only before it starts.

