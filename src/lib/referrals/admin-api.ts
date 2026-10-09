import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import type { Row } from '../members/runtime';
import { iso, membersRuntime, num, numOrNull, str, strOrNull } from '../members/runtime';
import { getUserByEmail, normalizeEmail } from '../members/users';
import { ensureReferralProfile } from './codes';
import type { ReferralCommission, CommissionStatus } from './commissions';
import { getCommission, rowToCommission } from './commissions';
import type { ReferralSettings } from './config';
import { MAX_REFERRAL_RATE, getReferralSettings, updateReferralSettings } from './config';
import { creditApprovedCommissions } from './jobs';
import { logReferralEvent } from './ledger';
import { effectiveRate } from './rates';
import type { ReversalOutcome } from './refunds';
import { reverseCommission } from './refunds';

/** Admin operations on referrers, commissions and settings, shared by REST and MCP. */

export const MAX_ADMIN_NOTE_LENGTH = 500;

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw !== '' ? Number(raw) : fallback;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new AppError(400, 'invalid_filter', `limit must be an integer 1-${max}`, { field: 'limit' });
  return n;
}

function optionalNote(raw: unknown, field = 'note'): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.trim().length > MAX_ADMIN_NOTE_LENGTH) {
    throw new AppError(400, 'invalid_field', `${field} must be text up to ${MAX_ADMIN_NOTE_LENGTH} characters`, { field });
  }
  return raw.trim() || null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function adminUpdateSettings(d1: D1DatabaseLike, patch: Record<string, unknown>, actor: string): Promise<ReferralSettings> {
  const before = await getReferralSettings(d1);
  const after = await updateReferralSettings(d1, patch);
  await logReferralEvent(d1, { actor, action: 'settings.updated', detail: { changed: Object.keys(patch), before: { ...before, updated_at: undefined } } });
  return after;
}

// ---------------------------------------------------------------------------
// Referrers
// ---------------------------------------------------------------------------

export interface AdminReferrerView {
  user_id: string;
  email: string;
  name: string | null;
  code: string;
  rate: number;
  tier_count_90d: number;
  tier_rate: number;
  admin_rate_override: number | null;
  admin_enabled: boolean;
  discount_percent: number;
  locked_at: string | null;
  lock_reason: string | null;
  leaderboard_opt_out: boolean;
  balance_cents: number;
  held_cents: number;
  referred_count: number;
  created_at: string;
}

const REFERRER_SELECT = `SELECT p.*, u.email, u.name,
    (SELECT COALESCE(SUM(l.amount_cents), 0) FROM referral_ledger l WHERE l.referrer_user_id = p.user_id) AS balance_cents,
    (SELECT COALESCE(SUM(c.commission_cents), 0) FROM referral_commissions c WHERE c.referrer_user_id = p.user_id AND c.status IN ('pending', 'review')) AS held_cents,
    (SELECT COUNT(*) FROM users r WHERE r.referred_by_user_id = p.user_id) AS referred_count
  FROM referral_profiles p JOIN users u ON u.id = p.user_id`;

function rowToReferrer(r: Row, settings: ReferralSettings): AdminReferrerView {
  const override = numOrNull(r, 'admin_rate_override');
  const count = num(r, 'tier_count_90d');
  return {
    user_id: str(r, 'user_id'),
    email: str(r, 'email'),
    name: strOrNull(r, 'name'),
    code: str(r, 'code'),
    rate: effectiveRate({ admin_rate_override: override, tier_count_90d: count }, settings),
    tier_count_90d: count,
    tier_rate: num(r, 'tier_rate'),
    admin_rate_override: override,
    admin_enabled: num(r, 'admin_enabled') === 1,
    discount_percent: num(r, 'discount_percent'),
    locked_at: strOrNull(r, 'locked_at'),
    lock_reason: strOrNull(r, 'lock_reason'),
    leaderboard_opt_out: num(r, 'leaderboard_opt_out') === 1,
    balance_cents: num(r, 'balance_cents'),
    held_cents: num(r, 'held_cents'),
    referred_count: num(r, 'referred_count'),
    created_at: str(r, 'created_at'),
  };
}

/** Admin: referrers matching an email, name or code fragment (all when empty), newest first. */
export async function searchReferrers(d1: D1DatabaseLike, opts: { q?: string | null; limit?: unknown } = {}): Promise<AdminReferrerView[]> {
  const limit = clampLimit(opts.limit, 50, 200);
  const q = (opts.q ?? '').trim().toLowerCase().slice(0, 100);
  // LIKE wildcards in the search text are escaped so they match literally.
  const pattern = `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`;
  const where = q ? "WHERE u.email LIKE ? ESCAPE '\\' OR lower(COALESCE(u.name, '')) LIKE ? ESCAPE '\\' OR p.code LIKE ? ESCAPE '\\'" : '';
  const { results } = await d1.prepare(`${REFERRER_SELECT} ${where} ORDER BY p.created_at DESC LIMIT ?`)
    .bind(...(q ? [pattern, pattern, pattern] : []), limit).all<Row>();
  const settings = await getReferralSettings(d1);
  return (results ?? []).map(r => rowToReferrer(r, settings));
}

async function getReferrerView(d1: D1DatabaseLike, userId: string): Promise<AdminReferrerView> {
  const row = await d1.prepare(`${REFERRER_SELECT} WHERE p.user_id = ?`).bind(userId).first<Row>();
  if (!row) throw new AppError(404, 'not_found', 'Referrer not found');
  return rowToReferrer(row, await getReferralSettings(d1));
}

const REFERRER_FIELDS = ['admin_rate_override', 'admin_enabled', 'locked', 'lock_reason'];

/**
 * Admin: rate override (null or 0–50), admin enablement (refer without a plan), lock with a reason or
 * unlock. The profile is created for a member who has none yet (e.g. to enable them).
 */
export async function updateReferrer(d1: D1DatabaseLike, rawEmail: string, body: Record<string, unknown>, actor: string): Promise<AdminReferrerView> {
  const email = normalizeEmail(rawEmail);
  const user = email ? await getUserByEmail(d1, email) : null;
  if (!user) throw new AppError(404, 'not_found', 'No member with this email');
  const unknownKey = Object.keys(body).find(k => !REFERRER_FIELDS.includes(k));
  if (unknownKey) throw new AppError(400, 'invalid_field', `${unknownKey} is not a referrer field`, { field: unknownKey });
  if (!REFERRER_FIELDS.some(k => k in body)) throw new AppError(400, 'invalid_request', 'Provide admin_rate_override, admin_enabled or locked');

  const sets: string[] = [];
  const params: unknown[] = [];
  if ('admin_rate_override' in body) {
    const v = body.admin_rate_override;
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_REFERRAL_RATE)) {
      throw new AppError(400, 'invalid_field', `admin_rate_override must be null or an integer between 0 and ${MAX_REFERRAL_RATE}`, { field: 'admin_rate_override' });
    }
    sets.push('admin_rate_override = ?');
    params.push(v);
  }
  if ('admin_enabled' in body) {
    if (typeof body.admin_enabled !== 'boolean') throw new AppError(400, 'invalid_field', 'admin_enabled must be a boolean', { field: 'admin_enabled' });
    sets.push('admin_enabled = ?');
    params.push(body.admin_enabled ? 1 : 0);
  }
  const now = iso(membersRuntime.now());
  if ('locked' in body) {
    if (typeof body.locked !== 'boolean') throw new AppError(400, 'invalid_field', 'locked must be a boolean', { field: 'locked' });
    if (body.locked) {
      const reason = optionalNote(body.lock_reason, 'lock_reason');
      if (!reason) throw new AppError(400, 'invalid_field', 'lock_reason is required when locking', { field: 'lock_reason' });
      sets.push('locked_at = COALESCE(locked_at, ?)', 'lock_reason = ?');
      params.push(now, reason);
    } else {
      sets.push('locked_at = NULL', 'lock_reason = NULL');
    }
  } else if ('lock_reason' in body) {
    throw new AppError(400, 'invalid_field', 'lock_reason is only accepted with locked: true', { field: 'lock_reason' });
  }

  await ensureReferralProfile(d1, user.id);
  await d1.prepare(`UPDATE referral_profiles SET ${sets.join(', ')}, updated_at = ? WHERE user_id = ?`).bind(...params, now, user.id).run();
  await logReferralEvent(d1, { actor, action: 'referrer.updated', subjectUserId: user.id, detail: { ...body } });
  return getReferrerView(d1, user.id);
}

// ---------------------------------------------------------------------------
// Commissions
// ---------------------------------------------------------------------------

const COMMISSION_STATUSES: CommissionStatus[] = ['pending', 'review', 'approved', 'reversed', 'blocked'];

export interface AdminCommissionView extends ReferralCommission {
  referrer_email: string | null;
}

export function parseCommissionStatus(raw: unknown): CommissionStatus | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const status = COMMISSION_STATUSES.find(s => s === raw);
  if (!status) throw new AppError(400, 'invalid_status', `status must be one of ${COMMISSION_STATUSES.join(', ')}`, { field: 'status' });
  return status;
}

/** Admin: commissions by status (default all), oldest review first so the queue is worked in order. */
export async function listCommissions(d1: D1DatabaseLike, opts: { status?: CommissionStatus; limit?: unknown } = {}): Promise<AdminCommissionView[]> {
  const limit = clampLimit(opts.limit, 100, 500);
  const { results } = await d1.prepare(
    `SELECT c.*, u.email AS referrer_email FROM referral_commissions c LEFT JOIN users u ON u.id = c.referrer_user_id
     ${opts.status ? 'WHERE c.status = ?' : ''} ORDER BY c.created_at ${opts.status === 'review' ? 'ASC' : 'DESC'} LIMIT ?`
  ).bind(...(opts.status ? [opts.status] : []), limit).all<Row>();
  return (results ?? []).map(r => ({ ...rowToCommission(r), referrer_email: strOrNull(r, 'referrer_email') }));
}

export type CommissionDecision = 'approve' | 'reject' | 'reverse';
export const COMMISSION_DECISIONS: CommissionDecision[] = ['approve', 'reject', 'reverse'];

export function parseCommissionDecision(raw: unknown): CommissionDecision {
  const decision = COMMISSION_DECISIONS.find(d => d === raw);
  if (!decision) throw new AppError(400, 'invalid_action', `action must be one of ${COMMISSION_DECISIONS.join(', ')}`, { field: 'action' });
  return decision;
}

export interface CommissionDecisionResult {
  outcome: 'approved' | 'released_to_hold' | 'rejected' | ReversalOutcome;
  commission: ReferralCommission;
}

/**
 * Admin decision on one commission.
 * - approve: a `review` commission is cleared; it becomes `approved` (and credited) when its hold has
 *   passed, otherwise `pending` so the daily job approves it at the end of the hold.
 * - reject: a `review` or `pending` commission becomes `blocked` (never paid, not counted).
 * - reverse: refund-style reversal of pending/review/approved, with a negative ledger line if credited.
 */
export async function decideCommission(
  d1: D1DatabaseLike, id: string, decision: CommissionDecision, actor: string, rawNote?: unknown,
): Promise<CommissionDecisionResult> {
  const note = optionalNote(rawNote);
  const commission = await getCommission(d1, id);
  if (!commission) throw new AppError(404, 'not_found', 'Commission not found');

  if (decision === 'reverse') {
    const res = await reverseCommission(d1, { commissionId: id }, note ?? 'admin_reversal', actor);
    if (res.outcome === 'not_reversible') throw new AppError(409, 'invalid_state', 'A blocked commission cannot be reversed');
    return { outcome: res.outcome, commission: res.commission ?? commission };
  }

  const nowMs = membersRuntime.now();
  const now = iso(nowMs);
  if (decision === 'approve') {
    if (commission.status !== 'review') throw new AppError(409, 'invalid_state', `Only a commission in review can be approved (status: ${commission.status})`);
    const matured = Date.parse(commission.hold_until) <= nowMs;
    const res = await d1.prepare(
      `UPDATE referral_commissions SET status = ?, approved_at = ?, updated_at = ? WHERE id = ? AND status = 'review'`
    ).bind(matured ? 'approved' : 'pending', matured ? now : null, now, id).run();
    if (res.meta?.changes !== 1) throw new AppError(409, 'invalid_state', 'The commission changed; reload and retry');
    if (matured) await creditApprovedCommissions(d1, nowMs, id);
    await logReferralEvent(d1, { actor, action: 'commission.review_approved', subjectUserId: commission.referrer_user_id, detail: { commission_id: id, matured, note } });
    return { outcome: matured ? 'approved' : 'released_to_hold', commission: (await getCommission(d1, id)) ?? commission };
  }

  if (commission.status !== 'review' && commission.status !== 'pending') {
    throw new AppError(409, 'invalid_state', `Only a commission in review or pending can be rejected (status: ${commission.status}); use reverse for approved ones`);
  }
  const reasons = JSON.stringify([...commission.review_reasons, 'admin_rejected']);
  const res = await d1.prepare(
    `UPDATE referral_commissions SET status = 'blocked', review_reasons = ?, updated_at = ? WHERE id = ? AND status IN ('review', 'pending')`
  ).bind(reasons, now, id).run();
  if (res.meta?.changes !== 1) throw new AppError(409, 'invalid_state', 'The commission changed; reload and retry');
  await logReferralEvent(d1, { actor, action: 'commission.rejected', subjectUserId: commission.referrer_user_id, detail: { commission_id: id, previous_status: commission.status, note } });
  return { outcome: 'rejected', commission: (await getCommission(d1, id)) ?? commission };
}
