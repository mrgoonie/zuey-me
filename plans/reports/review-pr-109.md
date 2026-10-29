## Review: PR #109 (closes #99) - Telegram join handler exempts verified admins

**Verdict: APPROVE**

Reviewed head `af0df3f` against `origin/main` in a separate worktree.

### Gates
- `bun install --frozen-lockfile`: OK
- `bun test`: 847 pass, 0 fail (46 files)
- `bun run build`: astro check reports 0 errors, 0 warnings and 63 hints (the hints already exist on main). The build completes.
- Regression proof: I restored `src/lib/experience/community.ts` from `origin/main` and kept the new test. The test then fails at `tests/experience.test.ts:659` (`Expected "joined"`, `Received "joined_then_removed"`). I reverted afterwards and committed nothing.

### Correctness
- **Only verified admins are exempt.** `community.ts:242-246` joins `users` and passes `email` and `email_verified_at` to `isAdminIdentity` at `community.ts:253`. The sweep uses the same helper at `community.ts:400`. `isAdminIdentity` returns false when `email_verified_at` is null (`members/admins.ts:21-23`). The test covers an email listed in `ADMIN_EMAILS` but not verified, and that user is removed.
- **Deleted user (LEFT JOIN gives a null email).** `str()` returns `''`, which is not an admin, so the handler falls through to the entitlement check as before.
- **Status and DB writes.** The `joined` UPDATE with `telegram_user_id` and `joined_at` (`community.ts:249-251`) runs before the exemption. An exempt admin therefore ends in `joined` with the Telegram id linked, so a later `left`/`kicked` update and the sweep both work. The handler makes no Telegram calls for that admin, and the test asserts this.
- **Matching the right member.** The lookup is still keyed on `invite_link + chat + status='invited'`. That is unchanged.
- **No PII in logs.** The PR adds no logging, and the response is still the outcome enum only.

### Webhook security
The secret check is unchanged: `TELEGRAM_WEBHOOK_SECRET` is required, the header is compared in constant time, and a mismatch returns 401 (`community.ts:212-217`). The secret check still runs before the PR's change, which comes after the DB lookup.

### Findings

**Low: a forwarded admin invite now keeps the stranger, permanently** (`community.ts:253`)
- **Today:** if an unpaid admin forwards their invite link, the person who uses it is removed at once, because the membership's owner is not entitled.
- **With this PR:** that person stays. The sweep then exempts the membership indefinitely, because the exemption follows the admin who owns the row (`community.ts:400`), not the Telegram account that joined.
- **Paid members:** the same weakness already exists for them, since Telegram does not tell the bot whose link it was beyond the link itself. A paid member's forwarded link, though, expires when their plan lapses. An admin's never does.
- **Exposure:** limited. The link has `member_limit: 1` and a one-hour TTL (`community.ts:168-173`), and only allowlisted admins with a verified email get one. I consider this acceptable for admin test links and not a blocker. If it matters, a follow-up could show the joined Telegram user to admins in the members directory.

**Nit: the test does not check the stored Telegram id for the admin** (`tests/experience.test.ts:659-661`)
The test asserts `status = 'joined'` but not that `telegram_user_id = '401'` was stored. This is optional hardening.

### Docs
- `docs/env-setup.vi.md` and the OpenAPI description now describe the join-time rule.
- These match the code, and the response enum is unchanged.
