Sets, inspects and controls timers: work that happens later — at a time or on a schedule — kept in this machine's timer registry so it outlives this turn and this session.

Use a timer instead of `sleep`, `wait`, or a polling loop whenever you are waiting for a clock time or for something you did not start in this session (CI, a remote job, a file, a process, a quota reset). Setting a timer does not hold the turn: set it, end your turn, and the timer wakes this session when it fires.

Rules
- Never say you will check back, follow up, or do something later unless a `set` here succeeded. Quote the card's id and fire time; the card is the record.
- `list` before `set`; one timer per purpose. To wait again after a fire, `set` the same `id`: that re-arms it and keeps its history. To change one thing about an armed timer (its time, prompt, expiry), `edit` it with only that field.
- `prompt` reaches a future turn that may start hours later, possibly with this session resumed headless: make it self-contained (what to do, which files, what done looks like).

One example per kind
- Wake this session later: {"op":"set","id":"finish-migration","at":"in 2h","prompt":"…","reason":"…"}
- Recurring check-in on this conversation: {"op":"set","id":"babysit","every":"30m","prompt":"…","reason":"…"}
- Recurring command, no model: {"op":"set","id":"prune-cache","every":"6h","shell":"…","reason":"…"}

Defaults: `session` is `origin`, this conversation; if it is closed when the timer fires, it is resumed headless. Recurring session wakes you set expire after 7 days unless `expires` says otherwise; recurring shell commands do not expire.
{{#if registry}}

Timers this session or this project set, as of when this session started (`list` for every timer and its current state; change one only when the user asks about it):
{{registry}}
{{/if}}
