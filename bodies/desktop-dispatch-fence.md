## What

I made a Windows UI Automation action whose reply misses the native reply wait report `AxUnconfirmed` when it may already have been sent, instead of a `Timeout` that reads as "nothing happened".

The session caller waits for the native worker's reply until a deadline, then returns `Timeout` whatever the worker had done. A fenced request now carries a three-state fence (idle, dispatched, abandoned) changed only by compare-and-swap. The route marks it just before the call that sends its action; when the wait expires the caller either finds the mark (`AxUnconfirmed`: the action may have been sent or may still take effect, inspect before retrying) or closes the fence, after which that request cannot send anything (`Timeout`).

Covered: Windows `press()` without a chord and `perform()` without a menu path, i.e. `Win32Ax::perform` (`press` and its pattern fallbacks, `invoke`, `toggle`, `expand`, `collapse`, `select`, `scrollintoview`). Only those requests allocate a fence. Coordinate clicks, `press(chord)`, `setValue`, focus, menu commands and other platforms keep `main`'s `Timeout`. The run's own abort is a separate path and does not close the fence. Both docs pages say this. The model guide is unchanged: the error text itself says to inspect before retrying.

Reading order: `DispatchFence` and `dispatching` in `desktop/control.rs`, `SessionCore::call_with_wait` in `desktop/mod.rs`, the `dispatching()` calls in `win32/ax.rs`.

## Why

UI Automation's client timeouts did not bound the calls I probed into a busy WPF dispatcher, so a route cannot keep its own call inside the caller's wait. Probe without omp: a WPF window whose dispatcher is blocked for 6 s, and a `CUIAutomation8` client with connection and transaction timeouts set to 1500 ms and read back:

| call while the dispatcher is blocked | Windows 10 22H2 | Windows 11 |
|---|---|---|
| `RangeValue` current value read, slider | 5/5 waited 5.8 s | 5/5 waited 5.8 s |
| `LegacyIAccessible.SetValue`, slider | 5/5 waited 5.8 s | 5/5 waited 5.8 s |
| `Toggle` state read, check box | 5/5 waited 5.8 s | 5/5 waited 5.8 s |
| `LegacyIAccessible.DoDefaultAction`, check box | 5/5 waited 5.8 s | 5/5 waited 5.8 s |

Each row is five ways of holding the element (default client, timed client, timed walker, runtime id, timed cache request). All 40 calls succeeded once the dispatcher was free; none ended at 1500 ms.

## Testing

`a_dispatched_provider_reply_timeout_is_unconfirmed` and `an_abandoned_provider_cannot_dispatch_after_reply_timeout` drive `SessionCore` with an injected provider and an injected end of the caller's wait, one per order: marked then expired is `AxUnconfirmed`; expired then marked is `Timeout` and the mutation never runs. Both pass at this head and fail with the caller's check removed (Linux). Four more cover the on-time reply, unfenced requests, the gate's off side and nested scopes.

Live, on a WPF check box pressed through `SessionCore` with a 750 ms reply wait (harness kept out of this PR), each order run separately at this head and with the caller's check removed:

| order | this head | caller's check removed |
|---|---|---|
| `Checked` handler blocks after the toggle began | `AxUnconfirmed`, box toggled once: Windows 11 3/3, Windows 10 3/3 | `Timeout`, box toggled once: Windows 11 3/3, Windows 10 3/3 |
| dispatcher blocked before the press | `Timeout`, box never toggled: Windows 11 3/3, Windows 10 3/3 | `Timeout`, box toggled late: Windows 11 3/3, Windows 10 3/3 |

Every press returned after 750 to 765 ms. The late toggle with the check removed shows the worker was past its last cancellation check, so only the fence stopped it at this head.

`scripts/rust-check` on Windows (cargo-xwin), Linux and macOS: clippy and rustfmt pass on this branch's lines at `64e43749b09`.
