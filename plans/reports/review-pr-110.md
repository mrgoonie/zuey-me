## Review: PR #110, atomic account deletion (closes #107)

**Verdict: APPROVE.** There are no blocking or medium findings.

Reviewed head `7abd2ae` (`fix/107-atomic-account-deletion`) against `origin/main`.

### Checks
1. **Behaviour diff.** The PR keeps all 12 writes in their original order and adds no new write. The only `SELECT` that feeds later work is `channel_identities` (users.ts:227). It still runs outside the batch, and its result is used only by the dewee invalidation after the commit. No statement in the batch depends on the result of an earlier one, and no `RETURNING` or `.first()` call moved into the batch. The 404 now comes from `meta.changes` of the first batch result (users.ts:249).
2. **Batch semantics.** `tests/helpers/d1.ts` wraps the statements in bun:sqlite `db.transaction(...)`, which rolls back the whole batch when any statement throws. Real D1 batches behave the same way. I confirmed the new test catches the regression: with `users.ts` and `referral-account-data.ts` reverted to main, it fails with "Received promise that resolved".
3. **Side-effect ordering.** Covered in findings 2 and 3 below.
4. **Retry.** When the batch fails, nothing is written: `deleted_at` stays NULL and a retry runs everything again. The test covers both the failure and the retry. `REFERRAL_KYC.delete` of keys that no longer exist and `INSERT OR IGNORE` of the paid-email hash are both idempotent, so the work done before the batch can safely run twice.
5. **Batch size.** The batch holds 12 statements. The whole request makes about 20 queries, the same number as before the change and well under D1's per-invocation query limits of 50 (free) and 1000 (paid). The transaction is short.
6. **Gates.**
   - `bun install --frozen-lockfile`: OK.
   - `bun test`: 847 pass, 0 fail.
   - `bun run build`: astro check reports 0 errors and 0 warnings (64 hints); the build completes.
7. **Live local check.** I applied the local D1 migrations (`--local` only) and started `bun run dev -- --port 4441`. I seeded one member with a user row, session, identity, channel identity, nonce, API key, login token, activity row, email_log row and payout profile, then called the real endpoint:
   - `DELETE /api/v1/me` with the wrong email returned 400 `confirmation_required`.
   - With the correct email it returned 200 `{deleted:true}` and cleared the cookie.
   - A repeat DELETE returned 401, and GET returned 401.
   - In local D1:
     - The user row was scrubbed: `deleted+…@deleted.invalid`, `name` and `canonical_email` NULL, `deleted_at` set.
     - Sessions, identities, channel identities, activity rows and the payout profile were all at 0 rows.
     - The nonce was anonymised (`''|''`).
     - The API key had `revoked_at` set and the login token had `used_at` set.
     - `email_log.to_email` was `''`.

   This exercises the real D1 batch through miniflare, including `meta.changes` on the batch results. I stopped the server by killing only its process tree.

### Findings
**Low**
1. users.ts:230-249: a second call on an account that is already deleted now runs the cleanup statements before returning 404. Before this PR it returned 404 before running them. The statements are idempotent for that user. The one statement that reaches other rows is `login_tokens ... OR email = ?` (users.ts:243), which uses the email held in the caller's `UserRecord`. If that record is stale, the statement could mark a token belonging to a new account registered with the same address since then. This needs two concurrent DELETEs on the same session (the first one deletes the session), so it is not practically reachable. No change needed.
2. referral-account-data.ts:37-52: `prepareReferralAccountDeletion` still runs before the batch. If the batch then fails, the national-ID images are already deleted from R2 and the paid-email hash is already recorded, while the payout profile row still points at the deleted image keys. A retry completes cleanly. If the member gives up on deletion, admins would see a profile with missing ID images. This ordering existed before the PR and is documented in the JSDoc. It is acceptable because the user asked for deletion.

**Info**
3. users.ts:227 and :252: the dewee invalidation set is read before the batch. A channel link committed between that read and the batch is deleted but not invalidated in dewee until its cache expires. The window has the same shape as before (a separate SELECT, then a DELETE), the author noted it, and the invalidation is best-effort.

**Nit**
4. `src/lib/members/users.ts` and `src/lib/referrals/referral-account-data.ts` lose their trailing newline.
5. The test checks rollback for only 5 tables. The batch is all-or-nothing, so the rest are covered by construction, but adding API keys and login tokens to the snapshot would be cheap.

Cleanup: I removed the review worktree, including its `dist/` and `.wrangler/`, and the scratch token files.
