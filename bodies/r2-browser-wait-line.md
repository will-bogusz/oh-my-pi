## What

My agents spend a large share of their browser time in hand-written `setTimeout` sleeps after clicks and page loads, guessing how long content takes, when the `waitFor*` helpers would return the moment it shows up.

On pages whose content arrives after an unknown 0.2–6 s delay, Opus 5.5 finished a task in 15.2 s with this line against 19.6 s on `main` (−4.4 s, 95% CI [−7.1, −1.9]); success stayed 100%.

The `browser` prompt's Waiting bullet, before → after:

> - Waiting: `waitFor`, `waitForSelector`, `waitForUrl`, `waitForText`. **They resolve as soon as the condition holds; after a click or navigation, wait for the expected text, URL, or selector instead of a fixed sleep.**

Non-goals: no new helper, no change to `waitFor*` behaviour; #12137 (a `waitFor(ms)` duration form) is separate.

## Why

In our own browser sessions, fixed sleeps made up 2,186 of 3,983 s (55%) of browser eval time, nearly all from Opus 5.5, most right after `goto`, `click` or `open`. The prompt lists the wait helpers without saying when to use them, so a model that cannot see when the page is ready sleeps a guessed amount: too short, and it spends another turn re-checking; too long, and it idles.

The measured gain is narrower than that share. The saving on delayed pages is mostly one fewer cell per task (about 0.8 fewer eval calls), not shorter sleeps. Where content is already there within 300 ms, the line changes nothing (Opus keeps its 500 ms sleep after a tab click), and Haiku 5.5 is unchanged.

## Testing

Local fixture site (Bun server, a random answer token per start), managed headless Chromium, `omp -p` with an isolated agent dir, `main` and this branch interleaved, every run finished:

| content appears | model, n per arm | success `main` / PR | fixed sleep ms per run | wall s, PR − `main` (95% CI) |
|---|---|---|---|---|
| 0.2–6 s after the action, new draw per load (2 tasks) | Opus 5.5 medium, 20 | 20/20 / 20/20 | 1650 → 1275 | −4.4 [−7.1, −1.9] |
| within 300 ms (3 tasks) | Opus 5.5 medium, 30 | 30/30 / 30/30 | 513 → 343 | +0.9 [−0.9, +2.9] |
| fixed 1.2–4 s (6 tasks) | Opus 5.5 medium, 48 | 48/48 / 48/48 | 1792 → 912 | −0.5 [−5.5, +5.3] |
| fixed 1.2–4 s (6 tasks) | Haiku 5.5 low, 36 | 32/36 / 31/36 | 1506 → 1536 | −0.2 [−6.2, +6.1] |

CIs are bootstraps resampled within each task. Fixed sleep is the sum of `setTimeout`/`Bun.sleep` delays written outside polling loops. On `main`, 9 of 98 Opus runs also called eval's global `wait(N)` as if it slept (it waits on job handles and returns at once); none did with the line. Dropping those runs, the delayed-page result is −4.7 s [−7.5, −1.8].

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
