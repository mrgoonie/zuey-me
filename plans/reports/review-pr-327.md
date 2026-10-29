# Review: PR #327 (closes #306): admin course revoke as one batch that fails on a lost audit row

Head `b917275`, one commit on `ee39420` (#317). `origin/main` has since moved to `60906c5` (#323, taxonomy only; no overlap with any file read here). `mergeStateStatus` is CLEAN. I reviewed in a fresh temporary worktree (`%TEMP%\rv327`) and removed it afterwards, together with its `node_modules`, `dist/` and `.wrangler/`. I did not push, comment or change labels.

## Verdict

**MERGE.** `revokeCourse` now runs exactly the `revokeCourseStatements` batch that the refund and dispute reversals use (#305). It covers every write the old function made: the certificate, the GitHub removal rows, the `courses.revoked` log and the purchase. Each write is guarded by an active purchase, and the purchase update runs last. A failure at any statement rolls back everything. REST answers the generic `500 internal_error` envelope and MCP answers a JSON-RPC tool error. The success contract `{ revoked: true | false }` is unchanged. The tests are real: 6 of the 9 new tests fail on main's source. I found no blocking findings, only one minor test gap and some nits.

## Evidence

- `bun test tests/courses-commerce.test.ts`: **82 pass, 0 fail** (1138 expects).
- **Fail on main, rerun.** I checked out the merge base's `src/lib/courses/course-purchases.ts` (`ee39420`) and kept the PR's tests: **76 pass, 6 fail**. The 6 failures are REST and MCP × {certificate revoke, GitHub removal, revoke log}. The three that pass are REST and MCP at the access revoke, which was the first write on main, plus the refund/dispute semantics test. This matches the PR body. I restored the file and `git status` was clean.
- Full `bun test`: **2083 pass, 0 fail** (117 files).
- `bun run build`: `astro check` reports 925 files, **0 errors, 0 warnings**, and the build completes.
- `gh pr checks 327`: `Test & Build` **pass** (2m48s). The head matches `b917275`.
- **Scope.** `git diff --stat origin/main...b917275` lists exactly 2 files: `src/lib/courses/course-purchases.ts` (+7/-11) and `tests/courses-commerce.test.ts` (+68, 0 deletions). The merge base is a recent main, and the PR reverts no merged work.

## Findings

### Critical
None.

### Major
None.

### Minor

1. **The MCP tests stop below the JSON-RPC layer.** `tests/courses-commerce.test.ts:669-675` calls `coursesMcpModule.call(...)` directly and asserts the raw `/injected/` rejection. The envelope that an MCP client actually receives comes from `src/pages/api/mcp.ts:91-105`: a non-`AppError` is mapped to `error: { code: -32000, message: 'Internal error', data: { code: 'internal_error' } }` with HTTP 500, and only `err.message` is logged.
   - Scenario: a future change in `mcp.ts` (for example, passing `err.message` through for non-`AppError`s) would leak `no such table …` or D1 text to MCP clients, and these tests would still pass.
   - The `mcp.ts` path is pre-existing and generic today, so this PR introduces no leak. The REST tests do go through `memberRoute` → `errorResponse` and assert `500 internal_error`. An optional fix is one test that posts `tools/call course_access_set` to the `mcp.ts` `POST` with a failing D1 and asserts `-32000`, `data.code = internal_error`, and no SQL in the body.

### Nit

1. **The module header is stale** (`src/lib/courses/course-purchases.ts:1-3`, pre-existing). It still says `grantCourse` and `revokeCourse` are the only writers of `course_purchases`, but `grantCourseStatements` and `revokeCourseStatements` also write it in other callers' batches. An optional fix is "the statement builders here are the only writers".
2. **The course is read twice** (`course-purchases.ts:100`, pre-existing). Both callers already ran `requireCourse` (`owners.ts:25`, `course-mcp.ts:140`), and `revokeCourse` reads the course again with `getCourseById`. This is harmless, and keeping the internal null-tolerant read keeps `revokeCourse` safe for other callers.
3. **D1 detail is logged server-side, not returned.** A failed batch logs `Unhandled API error: no such table: injected_failure` (`http.ts:40`) or `MCP tool error: …` (`mcp.ts:96`). The response bodies are generic. This matches the AGENTS.md envelope rule and is noted only for completeness.

## Focus answers

1. **Batch coverage.**

   | Old `revokeCourse` write (main) | New batch statement (`course-purchases.ts:124-132`) |
   | --- | --- |
   | `UPDATE course_purchases … status='revoked'` (first, gated `changes`) | last statement, same SQL plus optional `order_id` / `onlyIf` (both absent here) |
   | `UPDATE course_certificates SET revoked_at` (after the purchase update) | first statement, `AND EXISTS(active purchase)` |
   | `enqueueGithubSync(..., 'remove')` → one upsert per repo | `githubSyncStatements(..., 'remove', active)`, the same SQL as `enqueueGithubSync` (`course-github-invites.ts:29-46`) |
   | `logActivity('courses.revoked', {course_id, reason, actor})`, errors swallowed | `activityStatement(..., active)`, same detail and no user agent (`users.ts:170-181`), failure fails the batch |

   - **Guards.** Every earlier statement uses `EXISTS (… status = 'active')`, and the purchase update is last. So inside the D1 transaction they all see the pre-revoke state, and they apply together or not at all. This equals main's "only after `changes > 0`" ordering. With no `orderId`, the admin revoke ends access from any source (purchase or grant), as before. With no active purchase, every statement is a no-op.
   - **Other access is untouched.** `course_purchases` is unique per `(user_id, course_id)`, so the statements touch only that user's row for that course. The certificate update is scoped the same way.
   - **Course null.** `revokeCourseStatements` skips GitHub rows when the course is null. Both callers `requireCourse` first, so null does not happen in practice.
2. **Return value.** `Boolean(results.at(-1)?.meta?.changes)` reads the purchase update, which is the last statement. A second revoke finds no active row, so every guard is false and the call returns `revoked: false` with no extra log, removal or certificate change. The tests assert this at `:693-697` (counts stay at 1). Two concurrent revokes are serialized by D1, and the second batch's guards are then false.
3. **Errors.** REST: `memberRoute` → `errorResponse` (`account.ts:32-39`, `http.ts:37-41`) returns `{ success: false, error: { code: 'internal_error', message: 'Internal server error' } }` with status 500, and `withRequestId` adds the request id. No internals are returned. MCP: the raw error propagates to `mcp.ts:91-105`, which returns JSON-RPC `-32000` with `Internal error` and HTTP 500. No OpenAPI change is needed, because the success schema is unchanged.
4. **Admin revoke, then refund or dispute.** The reversal batch calls `revokeCourseStatements` with `orderId`. After an admin revoke the purchase is no longer active, so the revoke half is a no-op, and only the order status, the order log and (for a refund) the outbox row are written. The test at `:701-721` asserts one `courses.revoked` per user, one removal and one certificate revoke each, `refunded` / `charged_back` statuses, and exactly one refund outbox key. This test passes on main too, which confirms the behaviour is unchanged.
5. **Tests are meaningful.** `failingD1` (`:502-526`) fails a matching statement alone (throws) or inside a batch, where it swaps in `INSERT INTO injected_failure`. That is a missing table, so the `bun:sqlite` transaction rolls back as D1 would. Each failure point is checked for zero writes, then a real retry, then an idempotent repeat. Two surfaces × 4 points + 1 semantics test = 9, and 6 fail on main, as stated above.
6. **Scope.** Only the 2 files. The admin grant has the same non-atomic shape and is already filed separately as **#328** (open, P3), so this PR correctly does not widen.
