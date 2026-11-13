## What

I saw our benchmark's agent read the whole window again after a refused click, although the refusal had already given it the element's new ref, so a relabelled-ref refusal that names the element's current reading now says to act on that ref if it is the control meant, and otherwise to read the window.

When a macOS element action refuses because the ref's element now reads with another role or label, the error gives that element a ref as it reads now (`eN now reads as cell "…" [ref=eM]`) and ended with a bare "Re-run ax()/find()". In all three runs of one benchmark task on v18.20.0 the model did exactly that before acting on `eM`. The message now ends "Act on that ref only if it is the control you meant; otherwise re-run ax()/find()", and keeps the bare advice when it could not name the element's current reading. What is refused, the candidate wording and the destroyed-element path are unchanged.

## Why

The old ref stays refused, so `eM` or a fresh read are the only ways on, and the read costs a step and a full window walk when `eM` is already the control. Where `eM` is a different control (Contacts' City element now answering as "Street"), the sentence still points to the read.

No-model scripts in a fresh macOS 26 VM, 10 trials per build:

| | v18.20.0 | this PR |
|---|---|---|
| Reminders list cell read before a reminder moved into it: click refused | 10 of 10 | 10 of 10 |
| the same ref clicked again at once | refused 10 of 10 | refused 10 of 10 |
| the ref the error names, clicked without a read | acted 10 of 10 | acted 10 of 10 |
| Contacts City ref after the street is typed: refused, nothing written | 10 of 10 | 10 of 10 |
| error ends with | `Re-run ax()/find()` | `Act on that ref only if it is the control you meant; otherwise re-run ax()/find()` |

## Testing

- `cargo test -p pi-natives --lib -- desktop::` on macOS: 603 passed. The updated assertion in `a_relabelled_ref_searches_its_window_only_once_when_its_proof_misses` fails with the change reverted; `a_relabelled_ref_whose_element_cannot_be_named_again_advises_reading_the_window` pins the bare advice when the element cannot be named. `rust-check` passes on macOS, Linux and Windows.
- Not measured: whether a model now skips the read. This changes only the error's last sentence; no model ran.
