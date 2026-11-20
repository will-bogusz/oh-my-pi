## What

I made a Windows UI Automation action whose reply misses the native reply wait report `AxUnconfirmed` when it may already have been sent, instead of a `Timeout` that reads as "nothing happened".

The caller used to return `Timeout` when its wait for the native worker ended, whatever the worker had done. A fenced request now carries a three-state fence (idle, dispatched, abandoned) changed only by compare-and-swap. The route marks it just before the call that sends its action; when the wait expires the caller either finds the mark (`AxUnconfirmed`: the action may have been sent or may still take effect, inspect before retrying) or closes the fence, after which that request cannot send anything (`Timeout`).

Covered: Windows `press()` without a chord and `perform()` without a menu path (`Win32Ax::perform` and its pattern fallbacks). Only those requests allocate a fence. Coordinate clicks, `press(chord)`, `setValue`, focus, menu commands and other platforms keep `main`'s `Timeout`. A fenced caller stops waiting 125 ms before the run's deadline; the run's own abort is separate and does not close the fence. Both docs pages say this; the model guide is unchanged.

Reading order: `DispatchFence` and `dispatching` in `desktop/control.rs`, `SessionCore::call_with_wait` in `desktop/mod.rs`, then the calls in `win32/ax.rs`.

## Why

UI Automation's client timeouts did not bound the calls I probed into a busy WPF dispatcher, so a route cannot keep its own call inside the caller's wait. Probe without omp: WPF dispatcher blocked 6 s, `CUIAutomation8` client timeouts set to 1500 ms and read back:

| call while the dispatcher is blocked | Windows 10 22H2 | Windows 11 |
|---|---|---|
| `RangeValue` current value read, slider | 5/5 waited 5.8 s | 5/5 waited 5.8 s |
| `LegacyIAccessible.SetValue`, slider | 5/5 waited 5.8 s | 5/5 waited 5.8 s |
| `Toggle` state read, check box | 5/5 waited 5.8 s | 5/5 waited 5.8 s |
| `LegacyIAccessible.DoDefaultAction`, check box | 5/5 waited 5.8 s | 5/5 waited 5.8 s |

Each row covers five ways of holding the element; all 40 succeeded once it was free.

### Limits

With will/win-button-click also in `main`, its BM_CLICK route must mark dispatch too; that line is ready as win-button-click-fence.

## Testing

`a_dispatched_provider_reply_timeout_is_unconfirmed` and `an_abandoned_provider_cannot_dispatch_after_reply_timeout` drive `SessionCore` with an injected provider and an injected end of the caller's wait, one per order: marked then expired is `AxUnconfirmed`; expired then marked is `Timeout` and the mutation never runs. Both pass at this head and fail with the caller's check removed (Linux). Three more cover the on-time reply, the off side (an unfenced `AxPerform` keeps `main`'s deadline and `Timeout`) and nested scopes.

On Windows 10 22H2 (native test exe from `ab7e6cf8acf`), `unfenced_requests_keep_their_native_reply_deadline_and_timeout` and the four fence tests pass.

Live, on a WPF check box pressed through `SessionCore` with a 750 ms reply wait (harness not in this PR), each order run separately at this head and with the caller's check removed:

| order | this head | caller's check removed |
|---|---|---|
| `Checked` handler blocks after the toggle began | `AxUnconfirmed`, box toggled once: Windows 11 3/3, Windows 10 3/3 | `Timeout`, box toggled once: Windows 11 3/3, Windows 10 3/3 |
| dispatcher blocked before the press | `Timeout`, box never toggled: Windows 11 3/3, Windows 10 3/3 | `Timeout`, box toggled late: Windows 11 3/3, Windows 10 3/3 |

The late toggle with the check removed shows the worker was past its last cancellation check, so only the fence stopped it at this head.

`scripts/rust-check` on Windows (cargo-xwin), Linux and macOS: clippy and rustfmt pass on this branch's lines at `ab7e6cf8acf`.

