# Review: PR #126 (closes #115): warn instead of failing the tick on a transient analytics retry

Head `50025f4`, merged locally with `origin/main` (`1136480`), clean merge. Reviewer did not write this code.

**Verdict: APPROVE (with notes).** No blocking findings.

## Verification against the outbox

- **Summary fields.** `claimed`, `sent`, `retried`, `dead`, `pending`, `status` and `skipped_reason` match `DrainResult` (`src/lib/analytics/outbox.ts:132-150`) and the drain OpenAPI schema (`src/lib/analytics/openapi.ts:46-47`).
- **Retry and dead-letter semantics.** `claimBatch` increments `attempts` when it claims a row. `deliverRow` marks a row `dead` when:
  - the payload JSON is invalid,
  - the taxonomy rejects it,
  - every destination returns 400, 413 or 422, or
  - `attempts >= OUTBOX_MAX_ATTEMPTS` (10).

  Otherwise the row is `retried` with `backoffMs` (5 min doubling, capped at 6 h). So "nothing sent and at least one dead" is a real signal: the row either exhausted its retries or was rejected.
- **Persistent low-volume outage escalates.** One row that fails every attempt (for example a rotated key returning 401, which is retried) is claimed only when it is due. Attempts 1 to 9 are `retried` and classified `warn`. Ticks in between claim nothing and are `ok`. The 10th attempt comes after 5+10+20+40+80+160+320+360+360 = 1355 min (about 22.6 h). It dead-letters, giving `claimed=1 sent=0 dead=1`, which is `fail` (`workers/scheduler/src/analytics-drain-check.ts:55`). Verified.
- **Warnings are still logged.** `jobs.ts:149` logs `warn` outcomes with `console.warn`. Only `fail` throws (`jobs.ts:140`).
- **Docs.** `docs/analytics-events.md:117` matches the code exactly: three thresholds, plus warn and fail cases.
- **Test fails on main.** With main's check restored (plus the exported constant), `warns on a single transient retry…` fails (`failed` is `true`). It passes on the PR head.

## Findings

| Severity | Location | Finding |
| --- | --- | --- |
| Low | `workers/scheduler/src/analytics-drain-check.ts:56-57` | The trade-off is intended, but here is what it costs. During a full outage at low volume (1–2 due rows per run), the cron now fails only when the first row dead-letters, about 22.6 h after its first failure. It used to fail within 5 min. It fails sooner if any single run claims at least 3 rows. Until then only `console.warn` lines appear. A stateless check cannot count consecutive warn runs, so the 22 h ceiling is the escalation path. Consider stating that latency in the doc's Monitoring bullet. |
| Low | `workers/scheduler/src/analytics-drain-check.ts:55,59` | A rejected payload (400/413/422, taxonomy or invalid JSON) dead-letters on its first attempt. The level then depends on what else was in the run: `fail` when it was the only claimed row, `warn` when other rows were delivered. Same cause, two levels. It cannot repeat, because dead rows are never reclaimed, so this is acceptable. Noting it for whoever reads the alerts. |
| Nit | `workers/scheduler/src/analytics-drain-check.ts:56` | `claimed` also counts rows whose delivery crashed (`settle: false`, left leased). That means "≥3 claimed, 0 sent, 0 dead" can include unsettled rows. Treating them as failures is the right call, so no change is needed. |

## Gates

- `bun install --frozen-lockfile`: ok
- `bun test`: 917 pass, 0 fail
- `bun run build`: 0 errors, 0 warnings (65 hints, same as before)
- New test fails against main's implementation: confirmed
