# Review: PR #277 (closes #269), Dodo membership dispute outcomes

Head `fix/269-dodo-dispute-outcomes` @ `054f7a6` (one commit), base `main` (one commit ahead, no overlap).
Reviewed in a scratch worktree, which I removed afterwards.

## Verdict

**Approve (no blockers).** The change is small and correct. Course behaviour is unchanged. The shared gate key works with production rows that already exist. Tests fail on main and pass on the PR. The findings below are minor or nits. The access-policy gap that remains should become its own issue and should not block this PR.

## Evidence

- `bun test` (PR head): **1785 pass, 0 fail**, 108 files, 62214 expects.
- `bun run build`: astro check **0 errors, 0 warnings** (70 hints), build complete.
- New tests on main source (`git checkout origin/main -- src`, PR's test file): `tests/referrals-commissions.test.ts` **25 pass, 4 fail**. The 4 failures are the accepted, lost and expired loops, plus accepted without opened. On the PR: 29 pass, 0 fail.
- Dodo docs (dispute intents page):
  - `accepted` and `lost` mean funds are returned to the cardholder.
  - `expired` "typically resolves against you".
  - `won` means funds are retained. `cancelled` means no further action.
  - `opened` means funds are held.
  - An RDR auto-resolution arrives as `dispute.lost` with `is_resolved_by_rdr: true`.
  - The page does not say that a dispute affects the subscription.

## Focus answers

### Idempotency

- **Replay and other funds-lost outcomes for the same dispute.**
  - `reversalKey` maps every `dispute_lost` kind to `dispute.lost:<dispute id>` (`src/lib/payments/dodo-billing.ts:677`).
  - `recordEvent` relies on the `payment_events` unique key, so only the first funds-lost outcome logs and queues the event. The outbox key is `refund:dodo:dispute_lost:<id>` (`commerce-events.ts:142`), and it was already `ON CONFLICT DO NOTHING`.
  - Tests verified this: one outbox row and two activity logs (opened plus the first lost outcome).
- **Lost before opened.**
  - The lost outcome reverses the commission, takes the `dispute.lost:` gate and queues the chargeback.
  - A later `dispute.opened` gets `already_reversed`, takes its own `dispute.opened:` gate, logs a second activity row and queues no refund. The result is correct: one chargeback.
  - Only "lost without opened" is tested. "Opened arriving after lost" is not (minor test gap below).
- **Concurrent deliveries.**
  - The commission update is guarded by `WHERE status IN REVERSIBLE`.
  - The gate is a unique insert, so only one request logs and queues.
  - If the winner throws, it deletes the gate and returns 5xx, so Dodo redelivers it. The losing request has already answered 200 with no write. That is safe.
- **Atomicity.** The gate insert, `queueRefund` and `insertActivity` are three separate statements, not a `d1.batch`.
  - A thrown error releases the gate (`dodo-billing.ts:695-697`).
  - If the worker is evicted or crashes after the gate insert and before `queueRefund`, the gate stays. Every later delivery then returns at line 678, and the chargeback is never reported or logged.
  - A crash between `queueRefund` and `insertActivity` loses only the log. The outbox dedupe means it can never double-count.
  - This was already true for `dispute.lost`. The PR widens it to all three outcomes behind one gate. See the Minor 1 finding.
- **Key collisions.** `payment_events` (provider `dodo`) holds these keys:
  - webhook ids (`msg_…`/`evt_…`, including the course handler's rows)
  - `charge:<payment id>`
  - `refund.succeeded:<id>`, `dispute.opened:<id>`, `dispute.lost:<id>`

  None of them can collide. `raw_type` now stores the real outcome (for example `dispute.accepted`) under the `dispute.lost:` key. The only `raw_type` readers count `payment.charge` and `payment.succeeded` rows (`dodo-billing.ts:419,424`), so this has no effect. The outbox key `refund:dodo:dispute_lost:` cannot meet the course key `refund:dodo:course_order:<id>:charged_back` or the refund key `refund:dodo:refund:<id>`.

### Course handler regression

None. The sets before and after are identical:
- Revoke: opened, accepted, lost, expired.
- Money lost: accepted, lost, expired.
- Restore: won, cancelled.

`DISPUTE_REVOKE` is rebuilt from `DODO_DISPUTE_FUNDS_LOST` (`course-payment-webhooks.ts:96`). Branches at lines 147-155 are unchanged apart from the renamed set. Access revocation and restoration for courses (`reverseCourseOrder` / `restoreCourseOrder`) are untouched. However, `tests/courses-commerce.test.ts` only exercises opened, won and lost, so accepted, expired and cancelled for courses are not pinned (minor test gap).

### Access policy

- **Membership:** a reversal never changes access (`dodo-billing.ts:651`). This holds for `refund.succeeded` too. Today a refunded member also keeps access, so the PR is consistent with the current refund policy.
- **Courses:** access is revoked on `refund.succeeded` and on `dispute.opened` and every funds-lost outcome. It is restored on won or cancelled.

This is a real gap. A member whose money went back (refund or lost chargeback) keeps paid access for the current period, and the Dodo subscription may keep renewing unless Dodo cancels it (the docs say nothing about this). Issue #269's impact line mentions "the member keeps access", but its Expected section only asks for the mapping, docs and tests.

**Recommendation: do not block this PR.** Open a separate issue (P2), for example "fix(payments): Dodo membership access after refund or lost chargeback". It needs a product decision:
- revoke immediately, or at period end;
- cancel the Dodo subscription through the API;
- whether `dispute.opened` should suspend access as it does for courses;
- how a won dispute restores access.

Any change there must cover `refund.succeeded` and the dispute outcomes together, or the two paths will diverge. Link it from #269.

### Docs

- `docs/analytics-events.md` (refund row, Dodo refunds section) matches the code: one gate, one key, the `event` field, and courses versus memberships.
- `docs/env-setup.vi.md` is accurate: subscribe all `dispute.*`; membership `dispute.opened` reverses commission only; won and cancelled restore nothing.
- The webhook header comment (`src/pages/api/webhooks/dodo.ts:14`) matches.
- One stale comment remains (Nit 1 below).

## Findings

### Blocker
None.

### Major
None.

### Minor

1. **The gate and analytics are not atomic, so a mid-request crash loses the chargeback for every outcome.** `src/lib/payments/dodo-billing.ts:678-698`.
   - Failure: if the worker dies after `recordEvent` inserts `dispute.lost:dsp_X` and before `queueRefund`, the gate is never released. Every redelivery, and the other funds-lost outcomes, hit `return` at line 678. The `refund` event and the `billing.card_reversal` log are never written, and revenue KPIs overstate.
   - This was already true for `dispute.lost` and `refund.succeeded`. It is not a regression and is rare.
   - Fix: write the gate, the outbox row and the activity row in one `d1.batch` (the outbox insert is `ON CONFLICT DO NOTHING`, so it batches cleanly). Track this as a hardening issue rather than widening this PR.
2. **`dispute.expired` is counted as money lost on a "typically" from the docs.**
   - Dodo's docs do not promise that the funds are returned. If an expired dispute later resolves as `dispute.won`, the membership chargeback is already queued and nothing reverses it. Courses also restore access without a purchase, so analytics under-count. Courses had this behaviour before, and the PR documents it.
   - Acceptable, but worth a one-line note in `docs/analytics-events.md`, or a check with Dodo support.
3. **The test gaps below would pin the claimed behaviour.**
   - `tests/referrals-commissions.test.ts:331-387` does not cover:
     - `dispute.opened` arriving after a funds-lost outcome (expect one chargeback and two logs);
     - a funds-lost outcome on a **renewal** charge (`outcome: 'renewal'`, chargeback queued, commission untouched).
   - `tests/courses-commerce.test.ts` has no case for `dispute.accepted`, `dispute.expired` or `dispute.cancelled`, so a later edit to the shared sets could change course behaviour without a test failing.

### Nit

1. The stale comment at `src/lib/payments/dodo-billing.ts:371-372` still says refund and dispute rows are keyed `<event type>:<id>`. Funds-lost outcomes now always use `dispute.lost:<id>`.
2. Open question, pre-existing: Dodo says RDR auto-resolutions arrive as `dispute.lost` with an automatic refund. If Dodo also sends `refund.succeeded` for that refund, the member gets two `refund` events (`refund:dodo:refund:<rid>` and `refund:dodo:dispute_lost:<did>`) and two logs. This is worth checking in Test Mode. It is not caused by this PR.

## Unresolved questions

- Does Dodo cancel or pause the subscription after a lost or accepted chargeback? This decides the access issue above.
- Does an RDR `dispute.lost` also emit `refund.succeeded`?
