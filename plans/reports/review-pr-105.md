## Review: PR #105 (closes #95) — clear channel link nonces on account deletion

**Verdict: APPROVE.** Head reviewed: `ef7af7a` (based on current `origin/main`).

### Gates
- `bun install --frozen-lockfile`: OK.
- `bun test`: 819 pass, 0 fail (44 files).
- `bun run build`: astro check found 0 errors, 0 warnings (63 hints); the build completed.

### Checks
1. **Schema validity** (`migrations/0021_channel_identities.sql:20-28`)
   - `channel_link_nonces.external_id` and `user_id` are `TEXT NOT NULL`, so blanking them to `''` (not NULL) is correct.
   - `user_id` has **no** foreign key to `users`, so no cascade would have removed these rows. The explicit cleanup is needed.
   - `users` rows are soft-deleted anyway.
2. **Replay of an anonymised nonce fails** (`src/lib/channel-access/identities.ts:117-131`)
   - The consume path only `INSERT`s the nonce. It never reads the row's `user_id` or `external_id`, so blank values cannot mislink or crash anything.
   - A replay hits the `nonce` PRIMARY KEY and raises `409 link_token_used`.
   - The identity insert sits in the same `d1.batch`, so it rolls back.
   - `linkPreview` (`:80-85`) returns `used`.
   - The new test asserts the carol replay returns `link_token_used`, so no throwaway check was needed.
3. **Expiry boundary**
   - A token is valid only while `exp > floor(nowMs/1000)`, which implies `exp*1000 > nowMs`. Its row is pruned only when `expires_at < now`.
   - So a still-valid token's row is never pruned, and there is no replay window.
   - Both the prune and the verify use the `membersRuntime` clock.
4. **Atomicity** (`src/lib/members/users.ts:224-247`)
   - Not batched. `deleteAccount` is a sequence of separate statements, and the new lines follow the existing pattern.
   - This is a pre-existing gap, not introduced here: if a statement fails after the `users` UPDATE, a retry returns 404 and the later cleanups never run.
5. **`channel_identities`**: already deleted on `main` (`users.ts:234-235`) and the gate cache is invalidated (`:246`). No change is needed.
6. **Privacy copy** (`src/pages/privacy.astro:90`, `:225`): accurate in both vi and en.
   - It says what is recorded: the code, the Telegram ID and the account.
   - It gives the 24 h maximum, which matches `MAX_LINK_TOKEN_LIFETIME_SECONDS`.
   - It says expired rows are pruned when a link is used or an account is deleted.
   - It says the ID and account are removed immediately on deletion.
7. **Issue scope**: both requirements are met. The issue's "prune on a schedule or each time a link is used" was already satisfied by `identities.ts:117`, so the PR body's claim that consume-time pruning is new is slightly overstated. It is not a code problem.

### Findings (by severity)
- **Low, pre-existing:** `src/lib/members/users.ts:227-246`. Account deletion is not atomic. A partial failure leaves the nonce, identity and session cleanup undone, and the 404 guard blocks a retry. Worth a separate issue, for example a `d1.batch` of the post-UPDATE statements. It should not widen this PR.
- **Nit:** `users.ts:239`. `UPDATE ... WHERE user_id = ?` has no index on `channel_link_nonces.user_id`. The table is tiny and pruned on every redeem and deletion, so the impact is negligible.
- **Nit:** the PR body says "expired rows are also pruned when a link is consumed". That behaviour already existed (`identities.ts:117`).

### Conflicts
- `git merge-tree` of #105 with #104 (`feat/89-admin-unlink-channel-identity`) is clean.
- #101 (`claude/analytics-outbox`) does **not** touch `privacy.astro`. Its only conflict (`docs/analytics-events.md`) already exists against `main` and is unrelated to #105.
- No other open PR touches `privacy.astro` or `users.ts`.
