## What

I've got a Devin account with a work org and a personal one linked to the same email, each on its own plan, and I want omp to actually read both, so a Devin login now remembers which org it belongs to and the two stop merging into one.

A Devin login now stores its email, user id and organization, and Devin identity is keyed by organization as Anthropic's and Codex's are:

| | before | now |
|---|---|---|
| `omp usage` | one Devin account, showing one organization's plan and quota | one row per organization, each with its own plan and quota |
| `omp usage accounts` | "no identity key" for every Devin login | `email:…\|org:…` per login |
| `auth.accountPolicies` | no selector can name a Devin login | `{ email, orgId }` names exactly one; `email` alone matches both and throws, the existing rule for org-scoped providers |
| `/logout`, `/session pin` | every Devin login labelled `https://app.devin.ai` | `you@example.com (org-…)` |
| session credential pins | never recorded (no identity to hash) | a resumed session returns to its organization's login |

The identity comes from the seat-status call `/usage` already makes, run once after the token exchange by a `devin-identity` after-exchange hook (`registry/oauth/devin.ts`, lazily loaded like its neighbours).

## Why

One Devin user can belong to several organizations, each with its own subscription and quota. Devin logins stored only tokens and usage merged by email, so a user with a Pro and a Max subscription under one email saw one of them in `omp usage`, and account policies could name neither.

Decisions:
- **Organization scope ships with the identity.** Both logins share a user id and email; keyed by account alone, the second sign-in would replace the first and their reports would keep merging.
- **A failed or stalled identity read (30 s bound, as for the token exchange) stores the login without identity**, as `main` stores every Devin login, rather than failing the sign-in, as Anthropic's identity hook does.
- **Non-goals:** logins stored before this keep working as on `main`; to identify one, sign in again, then remove the old entry (labelled `https://app.devin.ai`) with `/logout`. Ranking logins by remaining quota, the `devin-cli` seat-key login and the broker are untouched.

Maintenance: if Devin changes `GetUserStatus`, `/usage` breaks first and new logins go back to being stored without identity; both read the same fields in `usage/devin.ts`.

Related: #13878 (duplicate rows when identity cannot be recovered, Devin among them), #13884 (stores Devin's user id and email without the organization, so two organizations of one user would share a key).

## Testing

- `packages/ai/test/devin-login.test.ts` signs in twice through `AuthStorage.oauth.login("devin")` with the token and seat-status endpoints faked: same user id and email, different organizations. Result: two stored logins keyed `email:…|org:org-team` and `email:…|org:org-personal`, and two Devin usage reports (Pro and Max). With the fix reverted: both keys `null`, one report. The existing login test also checks that a failed identity read still returns the login, without identity.
- Live, against two real Devin logins (one user, two organizations), without sending a chat turn: the identity read returns the same email and user id with two different organization ids, and the store computes two different identity keys; on `main` both keys are absent.
- `bun test packages/ai/test/devin-login.test.ts`

Not run: a real browser sign-in through `omp login devin`; the live check fed real tokens to the hook directly.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
