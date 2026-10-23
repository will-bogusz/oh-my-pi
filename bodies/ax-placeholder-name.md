## What

I kept seeing the agent set Reminders due dates through the Details popover because `ax()` listed the new reminder's Add Date field as a bare `textfield`, so now a text field with no label of its own is named by its placeholder.

The new-reminder row as `ax()` printed it on `main` in a recorded run, and the names this head gives it (the placeholder strings another accessibility client read from the same row):

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

An AppKit text field without a label exposes the hint it shows only as `AXPlaceholderValue`, which `ax()` never read, so the three empty fields of a Reminders row printed identically. Accessible-name computation falls back to the placeholder for exactly this case ([HTML-AAM](https://www.w3.org/TR/html-aam-1.0/), the accessible name of a text input).

In two computer-use tasks that file reminders with due dates, every reminder in every run on `main` (4 of 4 runs) went through Details or ⌘I and a date control. A client whose tree named the field Add Date typed the remaining reminders' dates into it in the same call as the title, in all four of its runs.

Decisions:

- The placeholder is read in the same batched attribute read as the other labels, among the attributes a batch that fails as a whole skips. An app too busy to answer the batch shows the field unnamed and under a new ref, as on `main`, rather than paying one more lone read with its own timeout for every element.
- It also joins the attributes an element's identity hashes, so a read where the app answered everything but the placeholder leaves the field without an identity instead of matching a look-alike.
- A fallback name rather than a new `placeholder` field on every node: nothing else needs the hint, and a field with a value keeps its name so the value stays labelled.

Non-goals: Windows and Linux backends; fields that already carry a title or description.

## Testing

- `cargo test -p pi-natives --lib desktop::` on macOS: 473 passed, 0 failed. `a_field_without_a_label_is_named_by_its_placeholder` reads a text field whose only label is `AXPlaceholderValue`; with the fallback reverted it fails (`description` is `None`), and with the placeholder dropped from the identity attributes its busy-placeholder case fails.
- `scripts/rust-check`: clippy `--all-targets` and rustfmt pass on macOS and Linux.
- Not run: a live `ax()` of Reminders on this head; no macOS guest was available to this run.
