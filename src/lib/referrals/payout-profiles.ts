import type { D1DatabaseLike } from '../../db/store';
import type { R2BucketLike, RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { Row } from '../members/runtime';
import { base64Url, iso, membersRuntime, str, strOrNull } from '../members/runtime';
import { normalizeEmail } from '../members/users';
import { logReferralEvent } from './ledger';
import type { PayoutMethod } from './payouts';

/**
 * Where a referrer is paid. VN bank payouts need the tax identity (full name, CCCD number, address) and
 * front/back images of the national ID; the images live in the private `REFERRAL_KYC` R2 bucket only until
 * an admin approves or rejects the profile, and are deleted in that same request. PayPal needs an email.
 * Any change by the member sends the profile back for review.
 */
export type PayoutProfileStatus = 'draft' | 'submitted' | 'verified' | 'rejected';
export type IdImageSide = 'front' | 'back';
export const PAYOUT_PROFILE_STATUSES: PayoutProfileStatus[] = ['draft', 'submitted', 'verified', 'rejected'];
export const ID_IMAGE_SIDES: IdImageSide[] = ['front', 'back'];
export const MAX_ID_IMAGE_BYTES = 5 * 1024 * 1024;
export const ID_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
type IdImageType = (typeof ID_IMAGE_TYPES)[number];

/** Profile fields shown to the member and the admin; storage keys never leave the server. */
export interface PayoutProfileView {
  user_id: string;
  method: PayoutMethod;
  status: PayoutProfileStatus;
  full_name: string | null;
  bank_name: string | null;
  bank_account: string | null;
  national_id: string | null;
  address: string | null;
  paypal_email: string | null;
  has_id_front: boolean;
  has_id_back: boolean;
  verified_at: string | null;
  reject_reason: string | null;
  updated_at: string;
}

export interface StoredProfile extends PayoutProfileView {
  id_front_key: string | null;
  id_back_key: string | null;
}

export function rowToStored(row: Row): StoredProfile {
  const front = strOrNull(row, 'id_front_key');
  const back = strOrNull(row, 'id_back_key');
  return {
    user_id: str(row, 'user_id'),
    method: row.method === 'paypal' ? 'paypal' : 'vn_bank',
    status: PAYOUT_PROFILE_STATUSES.find(s => s === row.status) ?? 'draft',
    full_name: strOrNull(row, 'full_name'),
    bank_name: strOrNull(row, 'bank_name'),
    bank_account: strOrNull(row, 'bank_account'),
    national_id: strOrNull(row, 'national_id'),
    address: strOrNull(row, 'address'),
    paypal_email: strOrNull(row, 'paypal_email'),
    has_id_front: front !== null,
    has_id_back: back !== null,
    verified_at: strOrNull(row, 'verified_at'),
    reject_reason: strOrNull(row, 'reject_reason'),
    updated_at: str(row, 'updated_at'),
    id_front_key: front,
    id_back_key: back,
  };
}

export function toView(p: StoredProfile): PayoutProfileView {
  const { id_front_key: _front, id_back_key: _back, ...view } = p;
  return view;
}

export async function getStored(d1: D1DatabaseLike, userId: string): Promise<StoredProfile | null> {
  const row = await d1.prepare('SELECT * FROM referral_payout_profiles WHERE user_id = ?').bind(userId).first<Row>();
  return row ? rowToStored(row) : null;
}

export async function getPayoutProfile(d1: D1DatabaseLike, userId: string): Promise<PayoutProfileView | null> {
  const p = await getStored(d1, userId);
  return p ? toView(p) : null;
}

/** The private KYC bucket, or an explicit 503 naming the missing binding. */
export function requireKycBucket(env: RuntimeEnv): R2BucketLike {
  if (!env.REFERRAL_KYC) throw new AppError(503, 'storage_unavailable', 'National-ID storage requires the R2 bucket binding REFERRAL_KYC');
  return env.REFERRAL_KYC;
}

export function parseIdImageSide(raw: unknown): IdImageSide {
  const side = ID_IMAGE_SIDES.find(s => s === raw);
  if (!side) throw new AppError(400, 'invalid_side', 'side must be front or back', { field: 'side' });
  return side;
}

// ---------------------------------------------------------------------------
// Member: details
// ---------------------------------------------------------------------------

function text(body: Record<string, unknown>, field: string, min: number, max: number): string {
  const raw = body[field];
  const value = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (value.length < min || value.length > max) {
    throw new AppError(400, 'invalid_field', `${field} is required (${min}–${max} characters)`, { field });
  }
  return value;
}

function digits(body: Record<string, unknown>, field: string, pattern: RegExp, message: string): string {
  const raw = body[field];
  const value = typeof raw === 'string' ? raw.replace(/[\s.-]/g, '') : '';
  if (!pattern.test(value)) throw new AppError(400, 'invalid_field', `${field} ${message}`, { field });
  return value;
}

interface ProfileFields {
  method: PayoutMethod;
  full_name: string | null;
  bank_name: string | null;
  bank_account: string | null;
  national_id: string | null;
  address: string | null;
  paypal_email: string | null;
}

/** Validates the member's details for the chosen method; the other method's fields are cleared. */
export function parsePayoutProfileInput(body: Record<string, unknown>): ProfileFields {
  if (body.method === 'paypal') {
    const email = normalizeEmail(body.paypal_email);
    if (!email) throw new AppError(400, 'invalid_field', 'paypal_email must be a valid email', { field: 'paypal_email' });
    return { method: 'paypal', full_name: null, bank_name: null, bank_account: null, national_id: null, address: null, paypal_email: email };
  }
  if (body.method !== 'vn_bank') throw new AppError(400, 'invalid_field', 'method must be vn_bank or paypal', { field: 'method' });
  return {
    method: 'vn_bank',
    full_name: text(body, 'full_name', 2, 100),
    bank_name: text(body, 'bank_name', 2, 100),
    bank_account: digits(body, 'bank_account', /^\d{6,20}$/, 'must be 6–20 digits'),
    // CCCD (12 digits) or the older CMND (9 digits).
    national_id: digits(body, 'national_id', /^(\d{9}|\d{12})$/, 'must be a 12-digit CCCD (or 9-digit CMND) number'),
    address: text(body, 'address', 5, 300),
    paypal_email: null,
  };
}

/** VN profiles are only reviewable with both ID images; PayPal profiles are reviewable at once. */
function readyStatus(method: PayoutMethod, front: string | null, back: string | null): PayoutProfileStatus {
  return method === 'paypal' || (front && back) ? 'submitted' : 'draft';
}

export async function deleteObjects(env: RuntimeEnv, keys: (string | null)[]): Promise<void> {
  const present = keys.filter((k): k is string => Boolean(k));
  if (present.length) await requireKycBucket(env).delete(present);
}

/**
 * Member: saves payout details. The profile goes to `submitted` (or `draft` while VN images are missing)
 * and needs a fresh admin review, so a changed bank account is never paid unchecked. Switching to PayPal
 * deletes any stored ID images.
 */
export async function savePayoutProfile(d1: D1DatabaseLike, env: RuntimeEnv, userId: string, body: Record<string, unknown>): Promise<PayoutProfileView> {
  const input = parsePayoutProfileInput(body);
  const existing = await getStored(d1, userId);
  let front = existing?.id_front_key ?? null;
  let back = existing?.id_back_key ?? null;
  if (input.method === 'paypal' && (front || back)) {
    await deleteObjects(env, [front, back]);
    front = null;
    back = null;
  }
  const now = iso(membersRuntime.now());
  const status = readyStatus(input.method, front, back);
  await d1.prepare(
    `INSERT INTO referral_payout_profiles (user_id, method, full_name, bank_name, bank_account, national_id, address, paypal_email,
       status, id_front_key, id_back_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET method = excluded.method, full_name = excluded.full_name, bank_name = excluded.bank_name,
       bank_account = excluded.bank_account, national_id = excluded.national_id, address = excluded.address,
       paypal_email = excluded.paypal_email, status = excluded.status, id_front_key = excluded.id_front_key,
       id_back_key = excluded.id_back_key, verified_at = NULL, verified_by = NULL, reject_reason = NULL, updated_at = excluded.updated_at`
  ).bind(userId, input.method, input.full_name, input.bank_name, input.bank_account, input.national_id, input.address,
    input.paypal_email, status, front, back, now, now).run();
  await logReferralEvent(d1, { actor: userId, action: 'payout_profile.saved', subjectUserId: userId, detail: { method: input.method, status } });
  const saved = await getStored(d1, userId);
  if (!saved) throw new AppError(500, 'internal_error', 'Payout profile was not saved');
  return toView(saved);
}

// ---------------------------------------------------------------------------
// Member: national-ID images
// ---------------------------------------------------------------------------

export function isIdImageType(v: string): v is IdImageType {
  return ID_IMAGE_TYPES.some(t => t === v);
}

/** True when the bytes really are the declared image type (magic numbers), so the type header can't lie. */
function matchesMagic(bytes: Uint8Array, type: IdImageType): boolean {
  const at = (offset: number, sig: number[]): boolean => sig.every((b, i) => bytes[offset + i] === b);
  if (type === 'image/jpeg') return at(0, [0xff, 0xd8, 0xff]);
  if (type === 'image/png') return at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50]);
}

function randomObjectKey(): string {
  return `kyc/${base64Url(crypto.getRandomValues(new Uint8Array(24)))}`;
}

/**
 * Member: uploads one side of the national ID (raw body, `Content-Type` image/jpeg, png or webp, ≤ 5 MB)
 * to a random R2 key. A replaced image is deleted. Requires saved VN bank details first.
 */
export async function uploadIdImage(
  d1: D1DatabaseLike, env: RuntimeEnv, userId: string, side: IdImageSide, request: Request,
): Promise<PayoutProfileView> {
  const bucket = requireKycBucket(env);
  const existing = await getStored(d1, userId);
  if (!existing || existing.method !== 'vn_bank') {
    throw new AppError(409, 'payout_profile_required', 'Save VN bank payout details before uploading national-ID images');
  }
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!isIdImageType(type)) throw new AppError(415, 'unsupported_media_type', 'Upload a JPEG, PNG or WebP image');
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_ID_IMAGE_BYTES) throw new AppError(413, 'image_too_large', 'Images must be at most 5 MB');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) throw new AppError(400, 'empty_body', 'The image body is empty');
  if (bytes.byteLength > MAX_ID_IMAGE_BYTES) throw new AppError(413, 'image_too_large', 'Images must be at most 5 MB');
  if (!matchesMagic(bytes, type)) throw new AppError(415, 'unsupported_media_type', `The file is not a valid ${type} image`);

  const key = randomObjectKey();
  await bucket.put(key, bytes, { httpMetadata: { contentType: type } });
  const previous = side === 'front' ? existing.id_front_key : existing.id_back_key;
  const front = side === 'front' ? key : existing.id_front_key;
  const back = side === 'back' ? key : existing.id_back_key;
  const status = readyStatus('vn_bank', front, back);
  const now = iso(membersRuntime.now());
  const column = side === 'front' ? 'id_front_key' : 'id_back_key';
  try {
    await d1.prepare(
      `UPDATE referral_payout_profiles SET ${column} = ?, status = ?, verified_at = NULL, verified_by = NULL, reject_reason = NULL, updated_at = ? WHERE user_id = ?`
    ).bind(key, status, now, userId).run();
  } catch (err) {
    // Never leave an unreferenced ID image behind.
    await bucket.delete(key).catch(() => undefined);
    throw err;
  }
  if (previous) await bucket.delete(previous);
  await logReferralEvent(d1, { actor: userId, action: 'payout_profile.image_uploaded', subjectUserId: userId, detail: { side, status } });
  const saved = await getStored(d1, userId);
  if (!saved) throw new AppError(500, 'internal_error', 'Payout profile was not saved');
  return toView(saved);
}
