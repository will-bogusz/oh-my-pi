## What

I wanted to say "check back on this in two hours" from the session I'm working in, and see what's waiting, without dropping to a shell for `omp timer`.

`/timer in 2h <prompt>` now arms a wake of the session you are in, `/timers` lists and controls every timer, the status line shows `⏰ 1 · next 11:49` while this session has one armed, and the model can read and act on timers through `timer://`.

| In a session | Before | Now |
|---|---|---|
| Wake this session later | `omp timer set … --session <id> --prompt …` in a shell | `/timer in 2h <prompt>` (or `at 8:00`, `every 30m`); a card shows what was armed |
| Other timer verbs | shell only | `/timer ls`, `show`, `runs`, `logs`, `fire`, `pause`, `resume`, `rm`, `set`, `edit`, with the `omp timer` flags |
| Browse and control | `omp timer ls` | `/timers` sheet: list, card, newest run log; `f` fire, `p` pause/resume, `d d` remove |
| Know a wake is pending | nothing | status-line pill (and native HUD pill) for the armed timers this session set, with the next fire time |
| The model | no access | `read timer://` lists timers, cards, runs and logs; `write timer://<id>/fire\|edit\|pause\|resume\|remove` |

<img width="1400" alt="/timer in 2h check the build: a framed card titled 'Timer: armed check-the-build' with fires, does (wake this session), if busy, why, last and ticker rows, footer '/timer show check-the-build · /timer rm check-the-build'; the status line ends with the pill '⏰ 1 · next 13:22'" src="https://github.com/user-attachments/assets/7d3334bb-2a47-4dd1-b6c8-1c3c2e0a0ced" />

<img width="1400" alt="/timers sheet: 'Timers · 3 armed' listing check-the-build, dep-audit (selected) and nightly-backup, the selected timer's card below, and the key bar '↑↓ · ↵ card · l logs · f fire · p pause · d remove · esc close'; the pill stays in the status line" src="https://github.com/user-attachments/assets/aa66b9e6-3a6b-43c8-b971-fe6d3f92632e" />

Model writes are tiered by what the ticker will later run without asking again:

| Write to `timer://<id>/…` | Approval tier |
|---|---|
| a prompt timer that wakes the writing session | `write` |
| a shell timer, another session's timer, an edit that sets `shell`, an unreadable spec | `exec` |
| any write with `timer.enabled: false` | refused |

**Beyond the surfaces:** `write`'s approval now resolves the target `execute` writes (`resolveWriteTarget`, `tools/write.ts`). On `main` approval saw `timer://x/edit:raw` while execution wrote `/edit`, so a selector could lower the tier.

Reading order: `tools/timer-view.ts` (tiers, pill text) → `internal-urls/timer-protocol.ts` → `slash-commands/builtin-timer.ts`, `commands/timer.ts` → `timers/service.ts` → `tui/overlays/timers-panel.ts` → `interactive-mode.ts`.

## Why

Timers are set and watched from a shell today, while what you come back to is the session in front of you. Related: #2763, #8757, #7381, #5838.

Decisions:
- **`/timer` parses with the `omp timer` command's own flags**, not a second table, so every `set`/`edit` flag works in a session and stays in step with the CLI.
- **A prompt timer set from a session wakes that session** unless `--session` says otherwise, recorded as `created.session`, which the pill counts. The CLI still requires `--session`.
- **`timer://` has no create verb**: the model acts on existing timers; you create them.
- **`timer.enabled` turns off only the `timer://` writes**; `/timer`, `/timers` and reads stay.
- **The pill renders a cached string**, refreshed after `/timer` and every 30 s, not read per frame.

The one decision for the maintainer: three new in-session surfaces, `/timer` with `/timers`, a `timer://` scheme the model can write through under these approval tiers, and a status-line pill.

Maintenance: the sheet sizes itself to the overlay's `maxHeight: "90%"` by hand (the compositor exposes no resolved height); if that changes, the 80x24 viewport test in `timer-render.test.ts` fails. Non-goals: a model tool that creates timers, other hosts' timers, a pill for other sessions' timers.

## Testing

Live after the review fixes, Haiku 4.5 over RPC, isolated timer store and mailbox, 6 of 6 steps: `/timer in 1m` armed a wake, `/timer set` stored `--grace 5m --catchup skip`, the model listed timers via `read timer://` and paused one via `write`, `/timer resume` re-armed it, and the fire started a turn in the live session. Real TUI at 80x24, 30 timers: selection, card and key bar stayed in view through Down ×29, Up ×15 and `p`. Screenshots are from the final head (its last fix recolors the sheet's labels).

<details><summary>Telling lines from the live runs</summary>

```
> /timer in 1m Reply with exactly: SLASH_WAKE_OK
timer reply-with-exactly-slash-wake-ok armed (rev 1) — Thu 2026-10-22 11:06 PDT (today, in 60s), once
does   wake session 01a164ca-… (this session) → "Reply with exactly: SLASH_WAKE_OK"
> /timer set flags-check --reason 'flag parity' --every 2h --shell 'echo hi' --grace 5m --overlap skip --catchup skip
limits overlap skip · late slots skipped · grace 5m · pauses after 3 failures
$ omp timer show flags-check --json   → "overlap": "skip", "graceMs": 300000, "catchup": "skip"
tool read {"path":"timer://"}         → assistant: reply-with-exactly-slash-wake-ok
tool write {"path":"timer://reply-with-exactly-slash-wake-ok/pause","content":""}
timer reply-with-exactly-slash-wake-ok paused (rev 2) — paused, once
$ omp timer tick
  reply-with-exactly-slash-wake-ok fired reply-with-exactly-slash-wake-ok#1 — mailed to live session 01a164ca-…
assistant: SLASH_WAKE_OK
$ omp timer runs reply-with-exactly-slash-wake-ok
#1  … schedule  fired  slot 2026-10-22T18:06:42.402Z  delivery=delivered-live

TUI 80x24, 30 timers, /timers then:
down ×29 → ╭─ Timers · 30 armed · 30/30 ─…  │ › timer-29  armed   Fri 2026-10-23 17:11 PDT (tomorrow, in 1d5h) · …
up ×15   → ╭─ Timers · 30 armed · 15/30 ─…  │ › timer-14  armed   Fri 2026-10-23 02:11 PDT (tomorrow, in 14h59m) …
p        → title "29 armed · 15/30", │ › timer-14  paused  paused · job 14 │, hint "… p resume …"
```

</details>

`bun test` of `timer-surfaces`, `timers`, `session-mailbox`, `internal-urls`, `slash-commands` and `tools/write*`: 670 pass; tui `timer-render` and `status-line*`: 81 pass. `bun run check` in coding-agent and tui.

<details><summary>Review fixes and their negative controls</summary>

- **Approval matches the written URL**: a real `WriteTool` acting as the session that owns a prompt timer; `{"shell":"make"}` to `timer://wake-a/edit`, `:raw`, `:conflicts`, `[…#ABCD]` and `[…:raw#ABCD]` all resolve `exec`, and with write allowed but exec prompting nothing is stored. A non-shell `:raw` edit stays `write` and lands; a line-range selector is denied at approval; `timer.enabled=false` refuses. Reverting `write.ts`: 4 fail.
- **Sheet stays inside the terminal**: real `TUI` on an 80x24 `VirtualTerminal` with the overlay options interactive mode uses, 30 timers; Down ×29 shows timer-29 selected with the key bar and `30/30`, and `f`, `p`, `d d` act on it; a 200-line log keeps the selection and key bar, also after resizing to 80x12; widths 1–4 stay inside the width. Reverting `timers-panel.ts`: 3 fail.
- **`/timer set|edit` take the CLI flags**: through `runTimerSlash` on a real store, `--when 'every 2h' --overlap queue --catchup skip --grace 30m --pause-after 5 --allow-timers` are stored as given; a stale `--rev` edit changes nothing; `--grace none` clears it. Reverting `builtin-timer.ts`: 2 fail.
- **Sheet title and key hints are legible**: they were drawn in the frame's border tone (1.15:1 contrast on the dark theme); now the title is `muted` and the hints `dim`, and only the frame strokes keep the border tone. Reverting the `timers-panel.ts` change fails the new render test.

</details>

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
