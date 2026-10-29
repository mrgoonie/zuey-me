# Review: PR #264 — fix(oauth): rotate and issue refresh tokens in one batch (closes #196)

Head: `c464ce6` (`fix/196-oauth-refresh-atomic`). Files: `src/lib/oauth/tokens.ts`, `tests/oauth-mcp.test.ts`.
Reviewed independently in a scratch worktree from `origin/fix/196-oauth-refresh-atomic`.

## Verdict

**Approve with follow-ups.** The fix is correct under D1 semantics. Exactly one refresh can win, a failed write leaves the old token usable, and the response only goes out after its tokens are committed. I found no blocker or major issue. The follow-ups are:

- one test gap: the suite still passes if the batch is replaced by two separate writes;
- one product decision on a grace window, worth its own issue.

## Verification

| Check | Result |
| --- | --- |
| `bun test tests/oauth-mcp.test.ts` | 37 pass, 0 fail |
| `bun test` | 1730 pass, 0 fail (103 files) |
| `bun run build` | 0 errors, 0 warnings, 70 hints; build complete |
| Mutation M1: insert guard `EXISTS(... AND 1 = 1)` | 36/1: the concurrent test fails (matches the PR claim) |
| Mutation M2: replace `d1.batch` with `await insert.run(); await update.run();` (not atomic) | **37/0, all tests pass** |
| Mutation M3: drop the `UNROTATED` guard on the `UPDATE` | 37/0 (expected: the insert guard alone decides who wins) |
| Mutation M4: drop the rotation `UPDATE` from the batch | 34/3: reuse, rejected-refresh and concurrent tests fail |

The source file was restored after the mutations. `git status` was clean.

## Correctness analysis

**Is the batch atomic in D1, and does the guard stop two winners?** Yes.

- D1 runs a `batch()` as one SQL transaction on the database's single primary, a single-threaded Durable Object. Batches and statements from other requests do not interleave inside it.
- The `INSERT ... SELECT ... WHERE EXISTS (id = ? AND rotated_at IS NULL AND revoked_at IS NULL)` (`tokens.ts:79`) and the rotation `UPDATE` (`tokens.ts:199`) therefore see one serial view.
- The second batch finds `rotated_at` set, so its insert writes 0 rows and its update writes 0 rows. `issued.meta.changes` is 0, so it takes the reuse branch (`tokens.ts:201`).
- The guard runs on the primary inside the write. Correctness does not depend on the earlier `SELECT` at `tokens.ts:161`. This repo does not use D1 read replicas or the Sessions API (`withSession` appears only in GA4 code), so stale reads are not a factor today. The design would stay safe even if replicas were turned on.
- `oauth_tokens` has no triggers (`migrations/0007_oauth_mcp.sql:57-75`), so `changes` counts only the guarded insert.

**Does a failed insert leave the old refresh token usable?** Yes.

- The insert is the first statement in the batch. If it throws (for example on a unique-hash collision or a D1 error), the `UPDATE` never commits.
- `refreshTokens` throws, and `oauthErrorResponse` maps the error to a non-200 response. The old token is still unrotated, so a retry succeeds. The new trigger test proves this.

**Can the response return tokens that were not persisted?** No.

- `response` is returned only when `issued.meta.changes` is truthy (`tokens.ts:201-205`), which means the batch committed with the insert in it.
- The authorization-code path still awaits `insert.run()` before it returns (`tokens.ts:93-100`).

**Can reuse detection misfire on a legitimate single refresh?** Not in the code paths.

- A single uncontested refresh always has `EXISTS` true, because the same row was just read as unrotated and unrevoked.
- The only other way to reach the reuse branch is a concurrent revoke landing between the read and the batch: RFC 7009 `revokeTokenForClient`, or `revokeConnectedApp` setting `revoked_at`. The refresh is then rejected with a misleading "already used" message and the family is revoked again, which does nothing. That outcome is correct.
- This is an improvement on main. Before, a revoke landing between the claim `UPDATE` and the unconditional `issueTokens` insert left a freshly minted, unrevoked pair. The guard now closes that revoke bypass as well.

**One residual misfire outside the code:** the "commit succeeded but the response was lost" case. The batch commits, then the Worker is cancelled or the client times out before it reads the body. The client then retries with the old token, which now looks like reuse and revokes the grant. Atomicity cannot fix this, and main had the same exposure. It is the strongest argument for the grace window discussed below.

## Findings

### Blocker

None.

### Major

None.

### Minor

1. **The tests do not prove atomicity. Replacing the batch with two sequential writes passes the whole suite.**
   - Where: `tests/oauth-mcp.test.ts:509-567`, against `src/lib/oauth/tokens.ts:197-200`.
   - Evidence: mutation M2 passed 37/37.
   - Why the concurrent test misses it: the in-process SQLite is synchronous, and the two requests are released from `bothRead` (`:527`) and then de-synchronised by `crypto.subtle` awaits in `prepareTokens`. Request A finishes both of its writes before request B's insert runs.
   - Why the failure test misses it (`:554-567`): the trigger fails the insert, which is the first statement, so the update never runs whether or not the writes are batched.
   - Failure scenario: a later refactor (for example "batch is awkward, use two awaits") brings back the non-atomic window on real D1, where each statement is a network round trip. Both requests' inserts then pass `EXISTS` before either update lands, giving two winners and two live refresh tokens. CI stays green.
   - Fix:
     - Add a `BEFORE UPDATE ON oauth_tokens` `RAISE(ABORT)` variant that asserts no third row exists (`COUNT(*) = 1`) and that the old token still refreshes. Sequential writes would leave an orphan, unreturned token row.
     - Optionally, in the racing wrapper, also hold both requests at the guarded `INSERT` (wrap `run()` for statements starting with `INSERT INTO oauth_tokens`). The test would then fail whenever the insert and update are not in one batch.

2. **Strict reuse revocation now always ends the grant on a concurrent duplicate refresh. The behaviour is acceptable, but needs its own follow-up issue.**
   - Where: `src/lib/oauth/tokens.ts:191-204` (and `:164-167` for a later replay).
   - What changed: on main, the loser's `revokeFamily` and the winner's `issueTokens` insert raced, so the winner's new pair sometimes survived. Now the winner's pair is committed first and is always revoked. Behaviour is deterministic, but a client that refreshes twice in parallel will always be forced to re-authorize.
   - Failure scenario: Claude Code with two sessions sharing one stored refresh token (or an SDK client whose `auth()` runs twice on parallel 401s). Both refresh within about 50 ms, both get revoked, and the user has to log in again. Public bug reports describe exactly this pattern against rotating authorization servers. The rejection itself is correct per the spec; the experience is that sessions die.
   - Assessment against the specs:
     - RFC 9700 §4.14.2 and OAuth 2.1 (refresh token protection) say a reuse of a rotated token should invalidate the active refresh token, because the server cannot tell attacker from victim. Strict revocation is therefore compliant and the conservative default.
     - Neither document forbids a short reuse interval. Okta (grace period), Auth0 (rotation overlap or leeway) and Supabase (reuse interval) all ship one because of this exact client behaviour.
   - **Recommendation:**
     - Merge this PR strict. It fixes the real atomicity bug and matches the module's documented intent (`tokens.ts:156`).
     - Open a P2 follow-up for a reuse leeway of about 30 s, applied only to the immediate predecessor:
       - A presented token with `rotated_at > now - 30s`, `revoked_at IS NULL`, the same client and active consent gets a **new sibling pair** in the same family. This is not an idempotent replay: only hashes are stored, so the winner's tokens cannot be returned again.
       - The sibling insert should be guarded the same way, for example `WHERE EXISTS (... rotated_at > ? AND revoked_at IS NULL)`, so a revoke in between still wins.
       - Outside the window, keep the strict family revoke.
     - Trade-off: an attacker replaying a stolen token within 30 s of a legitimate rotation gets a pair, and reuse detection is skipped for that one presentation. The attacker already held a usable token, so this adds little. The leeway also covers the "commit succeeded but response lost" retry.
     - Rejected alternative: a non-destructive `invalid_grant` inside the window, with no revoke. If the attacker is the one who rotates first, the victim's presentation inside the window no longer revokes the attacker's family. That is worse for security than either strict revocation or sibling issuance.
   - Per AGENTS.md this belongs in a separate issue, not in this PR.

### Nit

3. **The test can hang instead of failing.**
   - Where: `tests/oauth-mcp.test.ts:524-528`.
   - Problem: if only one request ever reaches the held `SELECT`, for example because the other is rejected earlier after a future change, `await bothRead` never resolves. The test then dies on the bun timeout instead of the clear `expect(arrived).toBe(2)` assertion.
   - Fix: `Promise.race` with a short timer, or release on the first arrival after a tick.
4. **Brittle SQL-prefix match.**
   - Where: `tests/oauth-mcp.test.ts`, the `sql.startsWith('SELECT * FROM oauth_tokens WHERE refresh_hash')` check.
   - Problem: it is coupled to the exact query text at `tokens.ts:161`. A reformatted query would make the hold point silently disappear. `arrived === 2` catches it, but only after the hang described in nit 3.
5. **Misleading message after a concurrent revoke.** In the revoke-raced case, the loser's error message "Refresh token was already used" (`tokens.ts:203`) is inaccurate. It could use the same "used or revoked" wording as `:166`. This is cosmetic, since clients only act on `error: invalid_grant`.
6. **The comment slightly overstates the loser's behaviour.**
   - Where: `tokens.ts:193`.
   - Problem: the comment says the loser "revokes the family, including the winner's new pair". That holds only because `revokeFamily` runs after the loser's batch, which itself runs after the winner's commit. It is true today.
   - Fix: make the comment state the ordering it depends on, so a future move of `revokeFamily` into the batch does not change the behaviour silently.

## Sources consulted for client behaviour

- [Concurrent MCP OAuth refresh across sessions destroys valid credentials (Claude Code issue mirror)](https://claudeissues.com/issue/84440-bug-concurrent-mcp-oauth-refresh-across-sessions-destroys-valid-credentials-with)
- [Multiple concurrent local sessions race on OAuth refresh-token rotation](https://claudeissues.com/issue/80585-bug-multiple-concurrent-local-sessions-race-on-oauth-refresh-token-rotation-near)
- [MCP OAuth per-process refresh lock lets concurrent sessions race](https://claudeissues.com/issue/85236-mcp-oauth-per-process-refresh-lock-lets-concurrent-sessions-race-token-refresh-r)
- [Nango: concurrency with OAuth token refreshes](https://nango.dev/blog/concurrency-with-oauth-token-refreshes)

---

## Round 2 — delta `c464ce6..a97c98c` (grace window moved into this PR)

The new head adds:

- migration `0032_oauth_refresh_grace.sql`, which adds the `grace_uses` column;
- a 30 s grace window: a token rotated less than 30 s ago gets a sibling pair, at most 3 times, guarded inside one batch;
- strict reuse when the column is missing;
- a `BEFORE UPDATE` atomicity test;
- race tests that are now held at `batch`;
- README and `docs/env-setup.vi.md` notes.

I reviewed it on a fresh worktree at `a97c98c`.

### Round 2 verdict

**Approve.** I found no blocker or major issue. The grace window does what round 1 recommended, the guards hold under concurrency, and the migration is safe in both deploy orders. The round-1 minor (tests did not prove the rotation is atomic) is fixed. Two security trade-offs remain. Both are deliberate, documented in code and docs, and acceptable, but the owner should know about them (findings R2-1 and R2-2).

### Round 2 verification

| Check | Result |
| --- | --- |
| `bun test tests/oauth-mcp.test.ts` | 44 pass, 0 fail |
| `bun test` | 1737 pass, 0 fail (103 files) |
| `bun run build` | 0 errors, 0 warnings, 70 hints; build complete |
| Round-1 M2 (rotation batch replaced by two sequential writes) | **now 3 fail**: two held race tests plus the new `BEFORE UPDATE` rollback test. Round-1 gap closed |
| G1: drop `grace_uses < 3` from the DB guard | 1 fail (the cap race test) |
| G2: drop `revoked_at IS NULL` from the DB guard | 1 fail (the revoke-wins test) |
| G4: grace insert and counter run as two sequential writes | 1 fail (the revoke-wins test) |
| G5: drop the `grace_uses + 1` update | 3 fail |
| G3: drop `rotated_at > ?` from the DB guard only | 44/0: the JS pre-check at `tokens.ts:202` still enforces the window (see R2-5) |
| G6: drop `rotatedAt > graceStart` from the JS pre-check only | 44/0: the DB guard still enforces the window, so the two checks back each other up |

I also ran three ad-hoc probes, added temporarily to the test file and then reverted:

- **Cap under 6-way concurrency** (all six held at `batch`): statuses `[200,200,200,200,400,400]`, `grace_uses = 3`, 5 rows. The cap is exact (1 rotation + 3 siblings). The two losers then revoke the grant, so all four 200 responses' access tokens return 401.
- **Attacker persistence:**
  - The victim rotates T0 to T1.
  - At +5 s the attacker replays T0 and gets sibling S1.
  - At +2 h both lineages refresh normally (T1→T2, S1→S2), and S2 still works (`ping` 200).
  - Presenting T0 again after the window returns 400, after which both S2 and T2 return 401.
- **Expired-but-rotated token inside the window:** returns 400 with the family revoked (see R2-4).

### Answers to the coordinator's questions

- **Can an attacker with a stolen token keep a live sibling that the victim's later reuse cannot kill?** Yes, confirmed by the probe.
  - The victim's normal refreshes only touch its own lineage (`T1→T2→…`). The sibling's lineage is not rotated and is never "reused", so nothing ever revokes it.
  - Only three things kill it: a rotated token from the family presented after the window or past the cap; the user disconnecting the app; an RFC 7009 revoke of any token in the family. Short of that it lasts until 30 days of inactivity, and the expiry slides, so an active attacker keeps it indefinitely.
  - This is the trade-off round 1 accepted and the PR documents (`tokens.ts:60-75`, README, docs). Okta and Auth0 accept the same risk with their leeway features. See R2-1.
- **Does a reuse after the window revoke every sibling?** Yes. `revokeFamily` is keyed by `family_id`, and every sibling inherits the grant's family (probe plus the test at `oauth-mcp.test.ts` "revokes the grant when a rotated token is presented after the grace window").
- **Is the cap enforced under concurrency?** Yes.
  - The insert guard (`EXISTS … grace_uses < 3`) and the counter update run in one D1 transaction. Batches are serialised, so the cap is exact (6-way probe; mutations G1 and G5).
  - Going past the cap falls through to the strict family revoke (`tokens.ts:255-258`). The same holds for a plain read of a token that is already rotated and out of the window, so an attacker cannot use the cap to get extra pairs.
- **Expiry and consent checks.**
  - Consent (`consentActive`), the scope-narrowing check and the resource check all run before either batch, so siblings never widen scope or audience.
  - Revocation is checked at read time and again inside the batch guard. A revoke that lands between the read and the batch wins (test, plus mutation G2).
  - A rotated token past its refresh expiry is excluded from the window (`!expired` at `:202`). That case takes the revoke branch, not the plain "expired" error (R2-4).

### Migration safety (`migrations/0032_oauth_refresh_grace.sql`)

- **Additive:** a single `ALTER TABLE … ADD COLUMN grace_uses INTEGER NOT NULL DEFAULT 0`.
  - SQLite allows `NOT NULL` with a constant default on `ADD COLUMN`, and existing rows read as 0.
  - The table has no triggers or views that could break.
  - Number 0032 is free: main ends at 0031, and the only other open migration PR (#235) uses 0029.
- **Apply before deploy is safe.**
  - Old code (`main` and `c464ce6`) uses explicit column lists in its `INSERT`s, so the new column takes its default.
  - `SELECT *` just returns an extra field that old code ignores.
  - Nothing else in `src/` writes `oauth_tokens`.
- **Deploy before apply is safe.**
  - `graceUses` becomes `null` when `row.grace_uses` is not a number (`tokens.ts:199`).
  - With `graceUses` null, `inGrace` is false, the grace batch is skipped (`:246`), and no SQL that names the column is ever prepared.
  - The behaviour is round-1 strict, with no 500. The test drops the column with `ALTER TABLE … DROP COLUMN` and checks this.
- **Rollback:** old code ignores the column, and the migration never needs to be reverted.
- **Remote apply:** this is a schema change, so AGENTS.md applies. Record `wrangler d1 time-travel info zuey_me_db` first, then run `wrangler d1 execute zuey_me_db --remote --file=./migrations/0032_oauth_refresh_grace.sql -y` with the `.env` account credentials exported. Either order is safe, but until the migration is applied, production keeps the strict behaviour.

### The two changed existing tests

The tests at `oauth-mcp.test.ts:478` ("rotates refresh tokens and revokes the family on reuse") and `:504` ("leaves the refresh token usable when a refresh is rejected…") now add `now += REFRESH_GRACE_MS` before presenting the reuse.

- **Correct:** an immediate reuse is now, by design, a grace sibling. At exactly +30 000 ms, `rotated_at > now − 30 s` is false, so these tests also pin the boundary as exclusive and strict.
- **No coverage lost:** immediate reuse is covered by the new sibling test, and post-window reuse by these two tests plus the new "after the grace window" test.

The rewritten race test helper (`holdGuardedWrites`) holds at `batch` and has a 1 s release fallback. That fixes round-1 nits 3 and 4: no hang, and no match on SQL text.

### Round 2 findings

**Blocker:** none. **Major:** none.

**R2-1 (minor, accepted risk).** A replay inside the window yields a sibling that cannot be detected.

- Where: `tokens.ts:202` and `:246-252`.
- Scenario: a real-time interceptor, such as a logging proxy or a compromised relay, captures T0 as the victim sends it. The attacker replays it within 30 s and gets a sibling lineage. Neither side then ever presents a rotated token, so reuse detection never fires, and the attacker keeps access until the user disconnects the app.
- Strict rotation would have revoked the grant on that replay. This is weaker than strict, but only for attackers who can act within 30 s of a legitimate refresh. An attacker who steals a stored token and uses it later still trips strict detection, because the victim's next refresh comes long after the window.
- The trade-off is documented accurately in the code comment, the README and the Vietnamese setup doc.
- Optional hardening, not required:
  - shorten the window to about 10 s, which still covers parallel 401s and lost-response retries;
  - and/or give a grace sibling the same `refresh_expires_at` as its predecessor instead of a fresh 30 days, so an undetected sibling cannot outlive the original grant's sliding lifetime.

**R2-2 (minor, behaviour).** More than 1 + 3 concurrent refreshes revoke the whole grant.

- Where: `tokens.ts:255-258`.
- Scenario: five or more sessions share one stored token and refresh within the same instant. Four get 200 responses, the fifth revokes the grant, and the four just-issued pairs die. Every session is forced to log in again (6-way probe).
- This is a bounded, deliberate choice, but the docs say "at most 3 times" without saying that the next request revokes the grant. Add half a sentence to the README and `env-setup.vi.md` line.

**R2-3 (nit).** No test checks that a sibling's own lineage is revoked by a post-window reuse.

- The "after the grace window" test only checks `first`'s access token, and the cap test only checks the cap path.
- My probe confirms the behaviour. A one-line assertion on a sibling pair's access token in the post-window test would pin it.

**R2-4 (nit).** An expired, rotated token inside the window revokes the grant.

- Where: `tokens.ts:202-207`.
- Scenario: client A refreshes T0 one second before its 30-day refresh expiry. Client B presents T0 one second after it. B fails `inGrace` because of `!expired` and takes the revoke branch, which kills A's fresh pair. Returning a plain `invalid_grant` "expired" without revoking would match the window's intent.
- This is extremely rare: it only happens at the 30-day boundary within the same 30 s.

**R2-5 (nit).** The DB-side window predicate (`rotated_at > ?` in `IN_GRACE`) has no test (mutation G3 survives).

- It only matters when a token crosses the 30 s boundary in the few milliseconds between the read and the batch. The JS pre-check covers every other case.
- Acceptable as defence in depth. A test could hold the batch and advance `now` past the window between the read and the write.

### Cleanup

The temporary worktree, including its `node_modules` and `dist/`, has been removed. The ad-hoc probes and mutations were reverted before removal, and `git status` was clean. Nothing was pushed, commented or merged.
