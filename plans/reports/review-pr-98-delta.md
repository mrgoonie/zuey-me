## Delta review: PR #98 (head c231229, issue #90)

**Verdict: APPROVE.** Fix the Medium finding before `COMMUNITY_SWEEP_MODE` is set to `live`. It can go in this PR or a follow-up.

### Gates (clean worktree at c231229)
- `bun install --frozen-lockfile`: OK
- `bun test`: 764 pass, 0 fail (42 files)
- `bun run build`: astro check 0 errors, 0 warnings (62 hints); build complete
- TypeScript rules: the diff adds no `any` and no unchecked casts. Narrowing uses `isRecord` / `typeof`. The only `as const` is on `SWEEP_JOB`.

### Findings

**Medium: one permanently stuck membership fails every cron run once the pass is short or done.** See `workers/scheduler/src/jobs.ts:75` (the docstring at `:54` claims the opposite).
`sweepCheck` fails the run when `errors > 0 && removed + revoked === 0`. In steady state most runs remove nothing. If one `joined` row fails every time, every run that reaches it reports `errors=1, removed=0` and fails the cron. Two examples: Telegram rejects the ban because the user is a chat administrator or owner, or the chat id is missing. When the whole table fits in one page (the 100-row default), that is every run, so the cron fails every 5 minutes and spends 2 Telegram calls each time. This contradicts the docstring's own claim that a single stuck membership only warns.
In dry-run mode `removed` and `revoked` are always 0, so any error at all fails the run. That case is rare, because errors there only come from a missing chat id.
Suggested fix: fail only when every attempted action failed and there were several of them, or when the error codes look systemic (`telegram_unreachable`, `internal_error`). Otherwise warn. In dry run, judge by `actions.length`. Add a test for "errors only, no actions, single error".

**Low: the migration number has a gap.** `migrations/0023_job_cursors.sql` skips 0022, which PR #101 uses (`0022_analytics_outbox.sql`). The two files do not collide with each other or with `0021_channel_identities.sql`. The migration itself is safe on a live DB: `CREATE TABLE IF NOT EXISTS`, a new table only, no data touched. It must be applied before merge. With the table missing, even the dry-run cron gets a 500, because a cursor-less run calls `job_cursors` (`community.ts:457`). The env-setup doc already says to apply it first.

**Low / informational:** a manual live sweep run by an admin (REST or MCP) without `cursor` moves the shared live cursor (`community.ts:457`). This is documented and harmless.

### Verified correct
- **Cursor pagination** (`community.ts:371`, `:455`): it reads `m.id > ? ORDER BY m.id LIMIT limit+1`. When the budget runs out it keeps `lastId ?? start`, so no row is skipped. The cursor row is deleted at the end of a pass. Live and dry-run cursors are stored separately. An explicit `cursor` (including `''`) never writes the stored point.
- **Dry run** never calls Telegram and never writes `community_memberships`. Its only write is its own `job_cursors` row. A test covers this.
- **Telegram budget:** 40 calls per run (a removal costs 2, a live revoke 1, an expired invite 0), which keeps a run under the 50-subrequest free-plan limit. The budget is checked before a row is counted.
- **Cron auth:** a single `isCronCaller` check; otherwise the caller must be an admin (`sweep.ts`). MCP uses `requireAdminPrincipal`. Input is validated by `parseSweepOptions`.
- **Admin exemption** uses the verified email in `ADMIN_EMAILS`. Expired admin invites are still retired.
- **Scheduler logs and PII:** the sweep summary holds only membership ids, actions, reasons, error codes, counts and the cursor. It contains no emails, user ids, Telegram ids or Telegram error messages, and tests assert this. A non-2xx response still logs a 500-char body slice. That body is an error envelope with no member data.
- **Other jobs:** `defaultCheck` keeps the `"status":"error"` detection. It now scans the full body instead of the first 500 chars, which is slightly stricter. Behaviour for non-2xx responses is unchanged. Only the sweep opts into skipping `503 community_unconfigured`.

### Merge conflict with PR #101 (`claude/analytics-outbox`, 8ace296)
`git merge-tree` reports a CONFLICT in `workers/scheduler/src/index.ts` (content) and in `workers/scheduler/src/jobs.ts` (add/add). #101 adds its own `jobs.ts` that exports `JOBS` with `/api/v1/analytics/outbox/drain`. To resolve it, keep #98's `jobs.ts` and `index.ts` and add `{ path: '/api/v1/analytics/outbox/drain' }` to `scheduledJobs()`. README and `docs/env-setup.vi.md` auto-merge. Recheck the "up to `0023`" migration line in env-setup after both land.
