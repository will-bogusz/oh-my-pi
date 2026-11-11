## What

I made `computer.window()`, `computer.windows()` and `win.find()` say what a filter takes when an agent passes a RegExp, instead of crashing with a TypeError or, for a bare RegExp, quietly matching every window.

| Call | `main` | This PR |
|---|---|---|
| `computer.window({ title: /Remote Desktop/ })`; also `windows()`, `{ app }`, Python `title=re.compile(…)` | `filter?.title?.toLocaleLowerCase is not a function` | ``window({ title }) takes text matched as a case-insensitive substring, not a RegExp; got a RegExp`` |
| `win.find({ title: /Save/ })`, `win.find({ value: 5 })` | the addon's ``Failed to convert JavaScript value `Object {}` into rust type `String` on AxQuery.title`` | ``find({ title }) takes text matched as a case-insensitive substring, not a RegExp; got a RegExp`` |
| `computer.window(/Editor/)`, `computer.windows(/Editor/)` | treated as no filter: the only window, or every window | ``window() takes a window id or an { app, title } filter of text matched as a case-insensitive substring, not a RegExp; got a RegExp`` |

String filters, `null` fields (still no filter), the `id` selector and `computer.run` arguments behave as before.

## Why

A RegExp is the natural thing to reach for here: `computer.run` documents RegExp values in its `args`. An agent that hit the TypeError on `computer.window({ title: /Remote Desktop/ })` had nothing in the error to correct, and finished that step outside the computer tool.

Rejecting is the fix that matches what filters are. Every window and element filter is documented and matched as a case-insensitive substring; `find()` matches in the native addon on all three platforms, and a direct helper call sends a nested RegExp as `{}` from JavaScript or an `__omp_re` marker from Python. Supporting RegExp would need a new wire encoding plus native matching on each backend, which is a feature rather than this fix. The check sits in the worker (`validateFilter` in `tools/computer/worker.ts`), so `run` code, direct JavaScript calls and Python all get the same message before any native call.

## Testing

A new worker test runs eleven calls through `computer.run`: RegExp, `{}`, Python-marker and number values for `title`, `app` and `value`, bare RegExp selectors for `window()`, `windows()` and `find()`, and `null` fields. The ten non-text calls return the named error without reaching the addon's `axQuery`, and the `null` call still lists windows. With the fix reverted the test fails: five `toLocaleLowerCase` TypeErrors and five non-text calls that do not fail at all.

Outside the suite I ran the real JavaScript prelude and the Python prelude against the worker: on `main`, `computer.window({ title: /Remote Desktop/ })` and `computer.window(title=re.compile("Remote"))` throw the TypeError and `computer.window(/Editor/)` returns the one open window; on this branch all three give the new message. The `find()` row's `main` error is what the macOS addon returns for a RegExp `title`.

```
cd packages/coding-agent && bun test test/tools/computer.test.ts   # 145 pass
```

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
