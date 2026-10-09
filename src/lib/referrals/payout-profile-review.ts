import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { Row } from '../members/runtime';
import { iso, membersRuntime, str, strOrNull } from '../members/runtime';
import { logReferralEvent } from './ledger';
import type { IdImageSide, PayoutProfileStatus, PayoutProfileView } from './payout-profiles';
import { PAYOUT_PROFILE_STATUSES, deleteObjects, getStored, isIdImageType, requireKycBucket, rowToStored, toView } from './payout-profiles';

/**
 * Admin review of referrers' payout profiles. National-ID images are only streamed to an authenticated
 * admin (audited, never cached) and are deleted from R2 in the same request that approves or rejects.
 */
export interface AdminPayoutProfileView extends PayoutProfileView {
  email: string | null;
  name: string | null;
  verified_by: string | null;
  created_at: string;
}

export function parseProfileStatus(raw: unknown): PayoutProfileStatus | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const status = PAYOUT_PROFILE_STATUSES.find(s => s === raw);
  if (!status) throw new AppError(400, 'invalid_status', `status must be one of ${PAYOUT_PROFILE_STATUSES.join(', ')}`, { field: 'status' });
  return status;
}

/** Admin: payout profiles (default: awaiting review), without images. */
export async function listPayoutProfiles(d1: D1DatabaseLike, status?: PayoutProfileStatus, limit = 200): Promise<AdminPayoutProfileView[]> {
  const { results } = await d1.prepare(
    `SELECT pp.*, u.email, u.name FROM referral_payout_profiles pp LEFT JOIN users u ON u.id = pp.user_id
     ${status ? 'WHERE pp.status = ?' : ''} ORDER BY pp.updated_at ASC LIMIT ?`
  ).bind(...(status ? [status] : []), Math.min(Math.max(Math.trunc(limit) || 200, 1), 500)).all<Row>();
  return (results ?? []).map(rowToAdminView);
}

function rowToAdminView(r: Row): AdminPayoutProfileView {
  return {
    ...toView(rowToStored(r)),
    email: strOrNull(r, 'email'),
    name: strOrNull(r, 'name'),
    verified_by: strOrNull(r, 'verified_by'),
    created_at: str(r, 'created_at'),
  };
}

async function getAdminView(d1: D1DatabaseLike, userId: string): Promise<AdminPayoutProfileView | null> {
  const row = await d1.prepare('SELECT pp.*, u.email, u.name FROM referral_payout_profiles pp LEFT JOIN users u ON u.id = pp.user_id WHERE pp.user_id = ?')
    .bind(userId).first<Row>();
  return row ? rowToAdminView(row) : null;
}

/** Admin: streams one ID image for review. Every view is audited; callers must send `no-store`. */
export async function readIdImage(
  d1: D1DatabaseLike, env: RuntimeEnv, userId: string, side: IdImageSide, actor: string,
): Promise<{ body: ArrayBuffer; contentType: string }> {
  const bucket = requireKycBucket(env);
  const profile = await getStored(d1, userId);
  const key = profile ? (side === 'front' ? profile.id_front_key : profile.id_back_key) : null;
  if (!key) throw new AppError(404, 'not_found', 'No national-ID image on file');
  const object = await bucket.get(key);
  if (!object) throw new AppError(404, 'not_found', 'No national-ID image on file');
  await logReferralEvent(d1, { actor, action: 'payout_profile.image_viewed', subjectUserId: userId, detail: { side } });
  const stored = object.httpMetadata?.contentType ?? '';
  return { body: await object.arrayBuffer(), contentType: isIdImageType(stored) ? stored : 'application/octet-stream' };
}

export type ProfileDecision = 'approve' | 'reject';
export const PROFILE_DECISIONS: ProfileDecision[] = ['approve', 'reject'];
export const MAX_REJECT_REASON_LENGTH = 500;

/**
 * Admin: approves (→ verified) or rejects a submitted profile. Both ID images are deleted from R2 first,
 * in this request; only then are the keys cleared, so a failed delete leaves the decision undone and
 * retryable instead of orphaning an image. A verified profile may also be rejected (revoked).
 */
export async function decidePayoutProfile(
  d1: D1DatabaseLike, env: RuntimeEnv, userId: string, decision: ProfileDecision, actor: string, rawReason?: unknown,
): Promise<AdminPayoutProfileView> {
  const profile = await getStored(d1, userId);
  if (!profile) throw new AppError(404, 'not_found', 'Payout profile not found');
  const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
  if (decision === 'approve') {
    if (profile.status !== 'submitted') throw new AppError(409, 'invalid_state', `Only a submitted profile can be approved (status: ${profile.status})`);
    if (profile.method === 'vn_bank' && !(profile.id_front_key && profile.id_back_key)) {
      throw new AppError(409, 'id_images_missing', 'Both national-ID images are required before approval');
    }
  } else {
    if (!reason || reason.length > MAX_REJECT_REASON_LENGTH) {
      throw new AppError(400, 'invalid_field', `reason is required (1–${MAX_REJECT_REASON_LENGTH} characters)`, { field: 'reason' });
    }
    if (profile.status !== 'submitted' && profile.status !== 'verified') {
      throw new AppError(409, 'invalid_state', `Only a submitted or verified profile can be rejected (status: ${profile.status})`);
    }
  }
  await deleteObjects(env, [profile.id_front_key, profile.id_back_key]);
  const now = iso(membersRuntime.now());
  if (decision === 'approve') {
    await d1.prepare(
      `UPDATE referral_payout_profiles SET status = 'verified', id_front_key = NULL, id_back_key = NULL, verified_at = ?, verified_by = ?,
         reject_reason = NULL, updated_at = ? WHERE user_id = ?`
    ).bind(now, actor, now, userId).run();
  } else {
    await d1.prepare(
      `UPDATE referral_payout_profiles SET status = 'rejected', id_front_key = NULL, id_back_key = NULL, verified_at = NULL, verified_by = ?,
         reject_reason = ?, updated_at = ? WHERE user_id = ?`
    ).bind(actor, reason, now, userId).run();
  }
  await logReferralEvent(d1, {
    actor, action: decision === 'approve' ? 'payout_profile.verified' : 'payout_profile.rejected', subjectUserId: userId,
    detail: { method: profile.method, reason: reason || null, images_deleted: [profile.id_front_key, profile.id_back_key].filter(Boolean).length },
  });
  const view = await getAdminView(d1, userId);
  if (!view) throw new AppError(500, 'internal_error', 'Payout profile disappeared');
  return view;
}
