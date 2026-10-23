## What

I kept seeing the agent set Reminders due dates through the Details popover because `ax()` listed the new reminder's Add Date field as a bare `textfield`, so now a text field with no label of its own is named by its placeholder.

On two reminder-filing tasks the agent now types dates into that field, and median steps fall 57 → 41 and 48.5 → 25.5 (measured alongside our other queued computer-use fixes, table below).

The new-reminder row as `main` printed it in a recorded run, and the names this head gives it:

```diff
         - group "Incomplete" [ref=e429]
           - checkbox "Mark as Completed" [ref=e430]: "0"
           - textfield [ref=e431] (focused)
           - button "Edit Details" [ref=e432]
-          - textfield [ref=e433]
-          - textfield [ref=e434]
-          - textfield [ref=e435]
+          - textfield "Notes" [ref=e433]
+          - textfield "Add Date" [ref=e434]
+          - textfield "Add Location" [ref=e435]
```

The name rides in the node's `description`, the slot a control that names itself only through `AXDescription` already uses, so `find({ title })` matches it too. A field's own title or description still wins.

## Why

An AppKit text field without a label exposes the hint it shows only as `AXPlaceholderValue`, which `ax()` never read, so the three empty fields of a Reminders row printed identically and the agent reached the date through Details or ⌘I for every reminder. Accessible-name computation falls back to the placeholder for exactly this case ([HTML-AAM](https://www.w3.org/TR/html-aam-1.0/), the accessible name of a text input).

Decisions:

- The placeholder is read in the same batched attribute read as the other labels, among the attributes a batch that fails as a whole skips. An app too busy to answer the batch shows the field unnamed and under a new ref, as on `main`, rather than paying one more lone read with its own timeout for every element.
- It also joins the attributes an element's identity hashes, so a read where the app answered everything but the placeholder leaves the field without an identity instead of matching a look-alike.
- A fallback name, not a new `placeholder` field: nothing else needs the hint, and a field with a value stays labelled.

Non-goals: Windows and Linux; fields with a title or description.

## Testing

Live, guest macOS VM, GPT-6.1 Sol (medium), 2 runs per task on each build; both builds carry our other queued computer-use fixes, the second adds this PR. All runs passed.

| | without this PR | with it |
|---|---|---|
| Calls naming the Add Date field, per task | 0–1 | 10–13 |
| Details / ⌘I detours: bills task, meeting task | 28, 49 | 13, 9 |
| Median steps: bills task, meeting task | 57, 48.5 | 41, 25.5 |
| Median steps, a plain Reminders task (control) | 10 | 10.5 |

- `cargo test -p pi-natives --lib desktop::` on macOS: 473 passed, 0 failed. `a_field_without_a_label_is_named_by_its_placeholder` fails with the fallback reverted (`description` is `None`), and its busy-placeholder case fails with the placeholder dropped from the identity attributes.
- `scripts/rust-check`: clippy `--all-targets` and rustfmt pass on macOS and Linux.
