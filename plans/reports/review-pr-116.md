# Review: PR #116 (closes #113), admin Telegram exemption follows the linked identity

Reviewed head `ec1f5bd`, merged locally with `origin/main` (`d1228aa`), no push. Isolated reviewer.

## Verdict

**Approve.** No blocking findings. The rule matches #113 and the stated design; the forwarded admin link no longer keeps a stranger, in either the join handler or the sweep.

## Correctness checks

- **Identity match** (`src/lib/experience/community.ts:199-203`): `provider = 'telegram' AND external_id = ? AND user_id = ?`. Provider value matches what `/connect` writes (`payload.channel_type`, `src/lib/channel-access/identities.ts:125`) and the 0021 backfill (`'telegram'`).
- **Id types:** `external_id` and `community_memberships.telegram_user_id` are both TEXT. The webhook binds `String(userIdNum)`; `/connect` stores dewee `sender_id` (Telegram user id as a decimal string); the backfill copies `telegram_user_id`. All decimal strings, so the comparison is consistent. The sweep reads `telegram_user_id` via `strOrNull`.
- **Revoked/unlinked identities:** there is no soft-revoke column; unlinking is a `DELETE` (`identities.ts:41`, `channel-access/admin.ts:98`, account deletion `members/users.ts:237`). After an unlink, the admin's seat loses the exemption on the next sweep. This is the intended result.
- **Multiple identities:** `UNIQUE (provider, external_id)` means one Telegram id maps to at most one user. An admin with several linked ids matches whichever one joined. Correct.
- **Join handler** (`community.ts:264-265`): the stranger and the unlinked admin fall through to the entitlement check and are removed. The membership row still records `telegram_user_id` and `status = 'removed'`. Joining writes nothing to `channel_identities`.
- **Sweep** (`community.ts:415-438`): `invited` admin rows stay exempt from `entitlement_lapsed` revocation. Expired links are still retired. A `joined` admin row is exempt only when its `telegram_user_id` is linked to the admin. Dry run and live share this decision, so dry-run `actions` match what live would do.
- **Paying members:** no change. `isAdminIdentity` short-circuits before the identity query, and entitled non-admins never reach it.
- No `any` or casts were added, nothing new is logged (no PII), and no migration was needed.

## Findings

### Low
1. **Rollout: admins who joined under #109 without a link.** As the author says, the first live sweep will remove these seats. `workers/scheduler/wrangler.toml:17` keeps `COMMUNITY_SWEEP_MODE = "dry_run"`, so for now they only appear in dry-run `actions` as `remove / entitlement_lapsed`. Before anyone runs a live sweep or flips the mode, the admin should link their account through `/connect`, or check dry-run output for their own membership id. Suggest one line in the PR or the docs.
2. **Docs heading now overstates the rule.** `docs/env-setup.vi.md:237` still opens with "**Admin không bao giờ bị mời ra**" ("admins are never removed"), but the sentence that follows qualifies it. Suggest "Admin dùng tài khoản Telegram đã liên kết không bị mời ra".

### Nit
3. **Two meanings of "link".** `docs/env-setup.vi.md:234` ("webhook gắn tài khoản Telegram với thành viên đã nhận link") and the JSDoc at `community.ts:216` ("Links the joining Telegram user to the member…") use "link" for recording `telegram_user_id` on the membership row. The same paragraph then says joining does not link an account. "Records the Telegram user id on the membership" would avoid the clash.
4. `community.ts:418-419` runs the identity query for every joined admin row, even when the admin is entitled and no action follows. With few admins the cost is negligible; computing it only when `action` is set would skip the query.
5. **Test gaps:** the new test does not cover dry-run output for a stranger on an admin row (`remove`/`entitlement_lapsed` listed, no Telegram call), or an admin who unlinks after joining. Both share already-tested code paths, so this is optional.

## Test quality

- New test `exempts an admin only on their own linked Telegram account…` against `origin/main`'s `community.ts`: **33 pass, 1 fail** (the new test fails). With the fix it passes. Verified locally.
- It covers: a stranger on a forwarded admin link (removed, ban+unban on 999); an unlinked admin (removed, no link created); the linked admin (kept); a sweep that removes a stranger seated on an admin row and exempts only the admin's own seat (`removed: 1, exempt_admins: 1`, Telegram calls only for 998).
- Existing admin tests now link first. The review nit from #113 (assert `telegram_user_id` stored on join) is added.

## Gates (merged with origin/main)

- `bun install --frozen-lockfile`: ok
- `bun test`: **900 pass, 0 fail** (50 files)
- `bun run build`: astro check **0 errors, 0 warnings**; build complete
- OpenAPI (`src/lib/experience/openapi.ts:136`), MCP `community_sweep` description (`src/lib/experience/mcp.ts:62`) and the sweep endpoint comment all match the behavior.

## Unresolved questions

- Should an admin with a plan who forwards a link also be covered? Today it behaves like a paid member's forwarded link (the stranger stays while the plan lasts). That is the same weakness paid members already have and outside #113.
