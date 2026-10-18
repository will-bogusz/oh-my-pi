## What

Factory Droid accounts whose WorkOS token carries no organization now get a token scoped to the account's organization, as the `droid` CLI does, instead of every request failing with 401 "User not affiliated with an organization".

After a login or refresh, the `factory-droid-region` hook calls whoami with the new token as before. If whoami returns no Factory org (a 401 or no `orgId`), and no WorkOS organization has been selected yet, the hook asks Factory which WorkOS organizations the user belongs to (`GET /api/cli/org`). If one comes back, it refreshes the grant with that `organization_id` and uses the re-issued token, with its `external_org_id` claim and the whoami identity for that token.

```
whoami(new token) ── Factory org ──► done (no lookup)
      │ 401 / no orgId, no WorkOS org selected yet
      ▼
GET /api/cli/org ── [] / error ──► login fails with whoami's error (as before)
      │ workosOrgIds[0]
      ▼
refresh_token grant + organization_id ──► scoped token ──► whoami ──► Factory org
```

- **Org ids stay separate:** the WorkOS id from `/api/cli/org` is used only in the refresh grant and stored as `activeOrganizationId`. `X-Factory-Org-Id` still comes only from the token claim or whoami.
- **At most one lookup:** the scoped refresh runs the hook again, with a WorkOS organization now selected, so the lookup and grant happen at most once per exchange.
- **Failures:** if the account has no organization, the lookup or scoped grant fails, or the scoped token still resolves no org, login fails with #14035's `Factory identity check failed (401): …` and the server's reason.
- **On refresh:** the scoped grant has already rotated the refresh token, so a refresh keeps the scoped credential either way.

This adds a second token rotation and two round trips to an org-less refresh, all within the 10 s refresh budget. That budget can already drop a refresh token the provider has rotated when it expires mid-exchange; that is fixed separately.

## Why

Fixes #14061. Refs #14032: #14035 closed it by making these logins fail loudly, and this change makes them work. Factory credentials being blocked without notice after these failures, as #14061 also describes, is not addressed here.

## Testing

- `packages/ai/test/factory-droid-oauth.test.ts` adds tests against mocked WorkOS and Factory endpoints:
  - org-less login and org-less refresh each make one lookup and one scoped grant, and end up with the scoped token, the rotated refresh token and the Factory org; the WorkOS id never reaches `X-Factory-Org-Id`;
  - no organization, a failed scoped grant, and a scoped token that still has no org each fail login with the whoami 401 and its reason;
  - a token without a claim that whoami already resolves, and a token that carries a claim, make no lookup and no grant.
  On main, 5 of these tests fail.
- Full `packages/ai` suite and `bun run check:ts` pass.
- Live: on an account whose token already carries an org, a `factory-droid/claude-haiku-4-5-20251001` request still succeeds. I have no org-less account, so that path is tested only against mocks.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
