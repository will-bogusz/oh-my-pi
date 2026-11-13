## What

I moved omp's Factory Droid client identity from droid 1.7.1 to 1.10.0, so Factory sees omp's requests as the current CLI's.

| On Factory requests | `main` | This PR |
|---|---|---|
| `User-Agent` / `X-Client-Version` | `factory-cli/1.7.1` / `1.7.1` | `factory-cli/1.10.0` / `1.10.0` |

> **Factory context.** omp's `factory-droid` provider presents itself to Factory's proxy as the `droid` CLI, so this version pin is its client identity, sent on inference, model discovery, `/usage` and image generation alike.

Reading order: `FACTORY_DROID_CLIENT_VERSION` (`catalog/src/wire/factory-droid.ts`) → the recaptured corpus.

## Why

droid 1.8.0 through 1.10.0 change no request field omp sends: the native corpus recaptured with droid 1.10.0 differs from the 1.7.1 corpus only in the two version headers, case for case.

Maintenance: each droid release needs this version bump and a corpus recapture; `factory-droid-native-parity.test.ts` fails on drift.

Non-goals: the models droid 1.8–1.10 add, which another PR carries.

## Testing

- Live from this branch on a Factory login, `omp -p` two-read turn (read two files, reply with their sum): 42 on `claude-haiku-5-5` (Messages) and `gpt-5.4-mini` (Responses).
- Native parity corpus recaptured with droid 1.10.0: 63 cases; apart from `user-agent` and `x-client-version`, every projected request equals its 1.7.1 counterpart. `factory-droid-native-parity.test.ts` 64 pass.
- `bun test` (`env -i`): `packages/ai` `test/factory-droid*.test.ts` 295 pass; `packages/catalog` `test/factory-droid*.test.ts` 51 pass. `check:types` clean for both packages.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
