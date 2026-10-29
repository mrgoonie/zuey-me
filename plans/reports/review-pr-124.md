# Review: PR #124 (closes #122): decode percent-encoded ids in the member unlink route

Head `333021f`, merged locally with `origin/main` (`1136480`), clean merge. Reviewer did not write this code.

**Verdict: APPROVE.** No blocking findings.

## Verification

- **Decoded exactly once.** Astro 5.18.2 runs `validateAndDecodePathname` (`node_modules/astro/dist/core/util/pathname.js`) before route matching. It applies `decodeURI`, which leaves reserved characters (`%3A`, `%40`, `%2B`, ...) encoded. It also rejects multi-level encoding: `App.match` returns no route (404) when a decoded path still contains `%XX`. So the route param still holds `777%3A002`, and the route's single `decodeURIComponent` produces `777:002`. A double-encoded `%253A` never reaches the handler. This is the same pattern as the admin route (`src/pages/api/v1/admin/channel-identities/[provider]/[externalId].ts:10`, #117).
- **Malformed input.** `%` and `777%E0%A4%A` return 400 `invalid_field` from `decodePathParam` (`src/lib/channel-access/admin.ts:35-42`). `SENDER_ID_RE` (`link-token.ts:22`) has no `%`, so no real sender id is lost to the 400.
- **Auth and ownership unchanged.** `requireCan('account:security')` and `requireUser` still run first. `unlinkChannelIdentity` still deletes `WHERE provider = ? AND external_id = ? AND user_id = ?` (`identities.ts:41`), so a member can only unlink their own identity. `logActivity` and `invalidateSenders` run only after a successful delete.
- **OpenAPI.** The `external_id` parameter description and the 400 response were added (`src/lib/channel-access/openapi.ts:89-91`).
- **Test fails on main.** With main's route file restored, `decodes a percent-encoded sender id…` fails (400 cases return 404). It passes on the PR head.

## Findings

| Severity | Location | Finding |
| --- | --- | --- |
| Low | `src/pages/api/v1/me/channels/[provider]/[externalId].ts:2`, `src/lib/channel-access/admin.ts:35` | The member route imports a generic helper from the admin module. This adds `admin.ts` and its imports (`ai/chat-store`, `members/users`, `invalidate`, `link-token`) to the member route's module graph. I checked: none of them has top-level side effects (pure declarations only), and the Pages worker is a single bundle, so nothing changes at runtime. For cleaner layering, `decodePathParam` could move to a shared module such as `src/lib/http.ts` in a follow-up. Not required. |

## Gates

- `bun install --frozen-lockfile`: ok
- `bun test`: 917 pass, 0 fail
- `bun run build`: 0 errors, 0 warnings (65 hints, same as before)
- New test fails against main's implementation: confirmed
