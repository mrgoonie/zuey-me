import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { parseUsdVndRate } from '../members/plans';
import type { Row } from '../members/runtime';
import { DAY_MS, iso, randomId, str, strOrNull, num } from '../members/runtime';
import { getReferralSettings } from './config';
import type { ReferralSettings } from './config';
import { logReferralEvent } from './ledger';
import { PAYEE_COLUMNS, payeeValuesFromProfile } from './payout-payee-snapshot';
import { ensurePayoutLedgerLine } from './payouts';
import type { PayoutMethod } from './payouts';
import { tierRateFor } from './rates';
import type { RecaptureResult } from './recapture-commissions';
import { recaptureMissingCommissions } from './recapture-commissions';
import { previousSaigonMonth, saigonParts } from './saigon-calendar';

/**
 * Time-based referral jobs, run by the cron worker every few minutes. Each job is idempotent and a no-op
 * when nothing is due, so a missed or doubled tick is harmless.
 */
export const TIER_WINDOW_DAYS = 90;

/**
 * Credits every approved commission that has no ledger credit yet, in one statement. Because the status
 * check and the insert are a single SQLite statement, a commission reversed concurrently is never credited,
 * and an approval interrupted before its credit is repaired on the next run. Zero-cent commissions (d = R)
 * stay approved for tiers and the leaderboard but carry no ledger line.
 */
export async function creditApprovedCommissions(d1: D1DatabaseLike, nowMs: number, commissionId: string | null = null): Promise<number> {
  const res = await d1.prepare(
    `INSERT OR IGNORE INTO referral_ledger (referrer_user_id, kind, amount_cents, commission_id, note, created_at)
     SELECT c.referrer_user_id, 'commission', c.commission_cents, c.id, c.source_kind || ' ' || c.source_id, ?
     FROM referral_commissions c
     WHERE c.status = 'approved' AND c.commission_cents > 0 AND (? IS NULL OR c.id = ?)
       AND NOT EXISTS (SELECT 1 FROM referral_ledger l WHERE l.kind = 'commission' AND l.commission_id = c.id)`
  ).bind(iso(nowMs), commissionId, commissionId).run();
  return res.meta?.changes ?? 0;
}

/**
 * Approves `pending` commissions whose hold has passed, unless the referrer is locked, then credits them.
 * `review` commissions are never approved here; an admin decides them.
 */
export async function matureCommissions(d1: D1DatabaseLike, nowMs: number): Promise<{ approved: number; credited: number }> {
  const now = iso(nowMs);
  const res = await d1.prepare(
    `UPDATE referral_commissions SET status = 'approved', approved_at = ?, updated_at = ?
     WHERE status = 'pending' AND hold_until <= ?
       AND NOT EXISTS (SELECT 1 FROM referral_profiles p WHERE p.user_id = referral_commissions.referrer_user_id AND p.locked_at IS NOT NULL)`
  ).bind(now, now, now).run();
  const approved = res.meta?.changes ?? 0;
  const credited = await creditApprovedCommissions(d1, nowMs);
  if (approved > 0) await logReferralEvent(d1, { actor: 'system', action: 'commissions.matured', detail: { approved, credited } });
  return { approved, credited };
}

/**
 * Refreshes each referrer's 90-day success count and tier rate. A success is a commission paid in the
 * window that is approved, or pending with its hold passed (a locked referrer's commissions stay pending);
 * review, reversed and blocked commissions do not count. Only changed profiles are written.
 */
export async function recomputeTiers(d1: D1DatabaseLike, nowMs: number, settings?: ReferralSettings): Promise<{ updated: number }> {
  const { tiers } = settings ?? await getReferralSettings(d1);
  const now = iso(nowMs);
  const since = iso(nowMs - TIER_WINDOW_DAYS * DAY_MS);
  const { results } = await d1.prepare(
    `SELECT p.user_id, p.tier_count_90d, p.tier_rate,
       (SELECT COUNT(*) FROM referral_commissions c
         WHERE c.referrer_user_id = p.user_id AND c.paid_at >= ? AND c.paid_at <= ?
           AND (c.status = 'approved' OR (c.status = 'pending' AND c.hold_until <= ?))) AS successes
     FROM referral_profiles p`
  ).bind(since, now, now).all<Row>();
  let updated = 0;
  for (const r of results ?? []) {
    const count = num(r, 'successes');
    const rate = tierRateFor(count, tiers);
    if (count === num(r, 'tier_count_90d') && rate === num(r, 'tier_rate')) continue;
    await d1.prepare('UPDATE referral_profiles SET tier_count_90d = ?, tier_rate = ?, tier_updated_at = ?, updated_at = ? WHERE user_id = ?')
      .bind(count, rate, now, now, str(r, 'user_id')).run();
    updated++;
  }
  return { updated };
}

export interface ClosedPayout {
  id: string;
  referrer_user_id: string;
  method: PayoutMethod;
  gross_cents: number;
  deduction_cents: number;
  net_cents: number;
  net_vnd: number | null;
}

export interface CloseResult {
  ran: boolean;
  /** Payout period label: the local month that just ended. */
  period: string | null;
  created: ClosedPayout[];
  skipped: { user_id: string; reason: 'payout_profile_not_verified' | 'referrer_locked' | 'already_closed' | 'usd_vnd_rate_missing' }[];
  /** Ledger lines repaired for payouts whose close was interrupted. */
  repaired: number;
}

/**
 * Day-1 close (Asia/Saigon). Every referrer whose balance reaches the threshold and whose payout profile
 * is verified gets one pending payout for the month that ended: gross = balance, minus the method's
 * deduction (VN bank `vn_deduction_bp`, PayPal `paypal_deduction_bp`); VN payouts are converted at
 * `USD_VND_RATE`. The verified payee details are snapshotted onto the payout, so editing the profile afterwards
 * never changes where this payout goes. The ledger books −gross, so negative balances (refunds after a payout) simply carry over.
 * UNIQUE (referrer, period) makes repeated runs on day 1 create nothing twice.
 */
export async function closePayoutPeriod(d1: D1DatabaseLike, env: RuntimeEnv, nowMs: number, settings?: ReferralSettings): Promise<CloseResult> {
  const repaired = await ensurePayoutLedgerLine(d1);
  if (saigonParts(nowMs).day !== 1) return { ran: false, period: null, created: [], skipped: [], repaired };

  const s = settings ?? await getReferralSettings(d1);
  const period = previousSaigonMonth(nowMs);
  const threshold = Math.max(s.payout_threshold_cents, 1);
  const { results } = await d1.prepare(
    `SELECT l.referrer_user_id AS user_id, SUM(l.amount_cents) AS balance, pp.method, pp.status AS profile_status, rp.locked_at,
       pp.full_name, pp.bank_name, pp.bank_account, pp.national_id, pp.address, pp.paypal_email, pp.verified_at,
       (SELECT 1 FROM referral_payouts x WHERE x.referrer_user_id = l.referrer_user_id AND x.period = ?) AS closed
     FROM referral_ledger l
     LEFT JOIN referral_payout_profiles pp ON pp.user_id = l.referrer_user_id
     LEFT JOIN referral_profiles rp ON rp.user_id = l.referrer_user_id
     GROUP BY l.referrer_user_id
     HAVING SUM(l.amount_cents) >= ?`
  ).bind(period, threshold).all<Row>();

  const result: CloseResult = { ran: true, period, created: [], skipped: [], repaired };
  const vndRate = parseUsdVndRate(env);
  const now = iso(nowMs);
  for (const r of results ?? []) {
    const userId = str(r, 'user_id');
    if (r.closed !== null && r.closed !== undefined) { result.skipped.push({ user_id: userId, reason: 'already_closed' }); continue; }
    if (strOrNull(r, 'locked_at')) { result.skipped.push({ user_id: userId, reason: 'referrer_locked' }); continue; }
    if (r.profile_status !== 'verified') { result.skipped.push({ user_id: userId, reason: 'payout_profile_not_verified' }); continue; }
    const method: PayoutMethod = r.method === 'paypal' ? 'paypal' : 'vn_bank';
    if (method === 'vn_bank' && vndRate === null) { result.skipped.push({ user_id: userId, reason: 'usd_vnd_rate_missing' }); continue; }

    const gross = num(r, 'balance');
    const bp = method === 'vn_bank' ? s.vn_deduction_bp : s.paypal_deduction_bp;
    const deduction = Math.round((gross * bp) / 10_000);
    const net = gross - deduction;
    const rate = method === 'vn_bank' ? vndRate : null;
    const netVnd = rate === null ? null : Math.round((net * rate) / 100);
    const id = randomId('rpo');
    const res = await d1.prepare(
      `INSERT INTO referral_payouts (id, referrer_user_id, period, method, gross_cents, deduction_bp, deduction_cents, net_cents,
         usd_vnd_rate, net_vnd, status, created_at, updated_at, ${PAYEE_COLUMNS.join(', ')})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ${PAYEE_COLUMNS.map(() => '?').join(', ')})
       ON CONFLICT (referrer_user_id, period) DO NOTHING`
    ).bind(id, userId, period, method, gross, bp, deduction, net, rate, netVnd, now, now, ...payeeValuesFromProfile(r)).run();
    if (res.meta?.changes !== 1) { result.skipped.push({ user_id: userId, reason: 'already_closed' }); continue; }
    await ensurePayoutLedgerLine(d1, id);
    await logReferralEvent(d1, {
      actor: 'system', action: 'payout.created', subjectUserId: userId,
      detail: { payout_id: id, period, method, gross_cents: gross, deduction_cents: deduction, net_cents: net, net_vnd: netVnd },
    });
    result.created.push({ id, referrer_user_id: userId, method, gross_cents: gross, deduction_cents: deduction, net_cents: net, net_vnd: netVnd });
  }
  return result;
}

type JobOutcome<T> = ({ status: 'ok' } & T) | { status: 'error'; error: string };

async function runJob<T>(name: string, job: () => Promise<T>): Promise<JobOutcome<T>> {
  try {
    return { status: 'ok', ...(await job()) };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'unknown';
    console.error(`referral job ${name} failed: ${error}`);
    return { status: 'error', error };
  }
}

/**
 * All referral jobs in dependency order: recapture of commissions whose capture failed on the payment path,
 * then maturity (so tiers and the close see fresh approvals), then tiers, then the day-1 close. A failing job
 * is reported as `status: "error"` (the scheduler flags it) without stopping the others.
 */
export async function runReferralJobs(d1: D1DatabaseLike, env: RuntimeEnv, nowMs: number): Promise<{
  recapture: JobOutcome<RecaptureResult>;
  mature: JobOutcome<{ approved: number; credited: number }>;
  tiers: JobOutcome<{ updated: number }>;
  close: JobOutcome<CloseResult>;
}> {
  const recapture = await runJob('recapture', () => recaptureMissingCommissions(d1, env));
  const mature = await runJob('mature', () => matureCommissions(d1, nowMs));
  const tiers = await runJob('tiers', () => recomputeTiers(d1, nowMs));
  const close = await runJob('close', () => closePayoutPeriod(d1, env, nowMs));
  return { recapture, mature, tiers, close };
}
