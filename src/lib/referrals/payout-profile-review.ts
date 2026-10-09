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
 * Admin: approves (→ verified) or rejects a submitted profile; a verified profile may also be rejected
 * (revoked). `expectedUpdatedAt` is the profile version the admin was shown: the update only applies while
 * the row still has that version, status, payee details and ID image keys, so a member edit or image upload
 * racing the decision yields 409 instead of verifying details nobody saw (or clearing a key whose image
 * would then never be deleted). Both ID images are deleted from R2 only after the guarded update succeeded,
 * using the keys from the same read; a failed delete is logged and audited with the keys for cleanup.
 */
export async function decidePayoutProfile(
  d1: D1DatabaseLike, env: RuntimeEnv, userId: string, decision: ProfileDecision, actor: string, rawReason?: unknown, expectedUpdatedAt?: unknown,
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
  if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt) {
    throw new AppError(400, 'invalid_field', 'updated_at of the reviewed profile is required', { field: 'updated_at' });
  }
  if (profile.updated_at !== expectedUpdatedAt) throw profileChanged();

  const now = iso(membersRuntime.now());
  const set = decision === 'approve'
    ? { sql: "status = 'verified', verified_at = ?, verified_by = ?, reject_reason = NULL", params: [now, actor] }
    : { sql: "status = 'rejected', verified_at = NULL, verified_by = ?, reject_reason = ?", params: [actor, reason] };
  const res = await d1.prepare(
    `UPDATE referral_payout_profiles SET ${set.sql}, id_front_key = NULL, id_back_key = NULL, updated_at = ?
     WHERE user_id = ? AND updated_at = ? AND status = ? AND method = ? AND full_name IS ? AND bank_name IS ? AND bank_account IS ?
       AND national_id IS ? AND address IS ? AND paypal_email IS ? AND id_front_key IS ? AND id_back_key IS ?`
  ).bind(
    ...set.params, now, userId, profile.updated_at, profile.status, profile.method, profile.full_name, profile.bank_name, profile.bank_account,
    profile.national_id, profile.address, profile.paypal_email, profile.id_front_key, profile.id_back_key,
  ).run();
  if (res.meta?.changes !== 1) throw profileChanged();

  const keys = [profile.id_front_key, profile.id_back_key];
  let imagesDeleted = keys.filter(Boolean).length;
  try {
    await deleteObjects(env, keys);
  } catch (err) {
    // The decision is committed; keep the keys on the audit trail so the images can still be removed by hand.
    imagesDeleted = 0;
    console.error('payout profile image delete failed:', err instanceof Error ? err.message : 'unknown');
    await logReferralEvent(d1, { actor, action: 'payout_profile.image_delete_failed', subjectUserId: userId, detail: { keys: keys.filter(Boolean) } });
  }
  await logReferralEvent(d1, {
    actor, action: decision === 'approve' ? 'payout_profile.verified' : 'payout_profile.rejected', subjectUserId: userId,
    detail: { method: profile.method, reason: reason || null, images_deleted: imagesDeleted },
  });
  const view = await getAdminView(d1, userId);
  if (!view) throw new AppError(500, 'internal_error', 'Payout profile disappeared');
  return view;
}

function profileChanged(): AppError {
  return new AppError(409, 'profile_changed', 'The payout profile changed since it was loaded; reload and review the current details');
}
