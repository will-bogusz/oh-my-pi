## What

I kept the tap fix but stopped priming iPhone Mirroring scrolls after a takeover.

[read] Scrolls pass straight through the primer gate, leaving the pending primer for the next tap. The tap primer and wheel-delta encoding are unchanged.

## Why

[read] v19.1.1 primes scrolls too. In an earlier paced-distance build tested live on 2026-11-23, the first +300 px scroll after takeover moved nothing with the primer (0/5); without it, requested ±300 px scrolls moved exactly (5/5).

[read] Separate probes found activating press → 100 ms → tap landed 5/5, while activating press → −300 px scroll moved 0/5. This fix retains the tap primer rather than removing it entirely.

## Testing

[read] Those phone results predate this build and are not delivery evidence for this head. That experiment shared the primer omission, but also cleared the pending mark and sent ten wheel events per 300 px; this head keeps the mark and main's single-wheel scroll.

[ran] `cargo test -p omp-natives desktop:: -- --nocapture`: 736 passed. The existing primer seam test checks that a scroll skips all primer checks/posts, invokes its action once, returns that action's error unchanged, and leaves the next tap primed.

[ran] Negative control: restoring scroll priming makes that test fail on its zero-primer-events assertion; restoring the fix passes the desktop suite.

[ran] `rust-check`: macOS and Linux clippy/rustfmt passed for this Rust diff.

Not run: this built head on a phone, v19.1.1's single-wheel scroll after takeover, or the mark-kept takeover → scroll → primed-tap sequence. All prior live rows clicked and scrolled at the same point; aiming a scroll elsewhere is unmeasured. Phone access ended before this build; this entry is held for a live run.

- [ ] `bun check` passes
- [x] Tested locally (offline tests only on this head)
- [ ] CHANGELOG attribution (added when opened)
