import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { exportReferralData, prepareReferralAccountDeletion, scrubReferralAccountData } from '../referrals/referral-account-data';
import type { Row } from './runtime';
import { isUniqueViolation, nowIso, randomId, str, strOrNull, userAgent } from './runtime';

export interface UserRecord {
  id: string;
  email: string;
  email_verified_at: string | null;
  name: string | null;
  avatar_url: string | null;
  locale: string;
  created_at: string;
  updated_at: string;
}

export const USER_LOCALES = ['vi', 'en'] as const;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

/** Lower-cased, trimmed email or null when it is not a plausible address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

export function rowToUser(row: Row): UserRecord {
  return {
    id: str(row, 'id'),
    email: str(row, 'email'),
    email_verified_at: strOrNull(row, 'email_verified_at'),
    name: strOrNull(row, 'name'),
    avatar_url: strOrNull(row, 'avatar_url'),
    locale: str(row, 'locale') || 'vi',
    created_at: str(row, 'created_at'),
    updated_at: str(row, 'updated_at'),
  };
}

export async function getUserById(d1: D1DatabaseLike, id: string): Promise<UserRecord | null> {
  const row = await d1.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').bind(id).first<Row>();
  return row ? rowToUser(row) : null;
}

export async function getUserByEmail(d1: D1DatabaseLike, email: string): Promise<UserRecord | null> {
  const row = await d1.prepare('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL').bind(email).first<Row>();
  return row ? rowToUser(row) : null;
}

/** Creates a member with a verified email, or returns the existing live account for that email. */
export async function findOrCreateVerifiedUser(
  d1: D1DatabaseLike,
  input: { email: string; name?: string | null; avatarUrl?: string | null },
): Promise<{ user: UserRecord; created: boolean }> {
  const existing = await getUserByEmail(d1, input.email);
  if (existing) {
    if (!existing.email_verified_at) {
      const now = nowIso();
      await d1.prepare('UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?').bind(now, now, existing.id).run();
      return { user: { ...existing, email_verified_at: now, updated_at: now }, created: false };
    }
    return { user: existing, created: false };
  }
  const now = nowIso();
  const id = randomId('usr');
  try {
    await d1.prepare(
      `INSERT INTO users (id, email, email_verified_at, name, avatar_url, locale, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'vi', ?, ?)`
    ).bind(id, input.email, now, input.name ?? null, input.avatarUrl ?? null, now, now).run();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = await getUserByEmail(d1, input.email);
    if (!raced) throw err;
    return { user: raced, created: false };
  }
  const user = await getUserById(d1, id);
  if (!user) throw new AppError(500, 'internal_error', 'User was not persisted');
  return { user, created: true };
}

export interface ProfileInput {
  name?: string | null;
  avatar_url?: string | null;
  locale?: (typeof USER_LOCALES)[number];
}

/** Validates PATCH /me bodies. Throws AppError 400 on any invalid field. */
export function parseProfileInput(body: Record<string, unknown>): ProfileInput {
  const out: ProfileInput = {};
  const bad = (field: string, msg: string): never => {
    throw new AppError(400, 'invalid_field', `${field} ${msg}`, { field });
  };
  if ('name' in body) {
    const v = body.name;
    if (v === null) out.name = null;
    else if (typeof v !== 'string' || v.trim().length > 80) bad('name', 'must be a string of at most 80 characters');
    else out.name = v.trim() || null;
  }
  if ('avatar_url' in body) {
    const v = body.avatar_url;
    if (v === null || v === '') out.avatar_url = null;
    else {
      let ok = false;
      if (typeof v === 'string' && v.length <= 500) {
        try {
          ok = new URL(v).protocol === 'https:';
        } catch {
          ok = false;
        }
      }
      if (!ok) bad('avatar_url', 'must be an https URL of at most 500 characters');
      out.avatar_url = typeof v === 'string' ? v : null;
    }
  }
  if ('locale' in body) {
    const v = body.locale;
    if (v !== 'vi' && v !== 'en') bad('locale', "must be 'vi' or 'en'");
    out.locale = v === 'en' ? 'en' : 'vi';
  }
  if (Object.keys(out).length === 0) throw new AppError(400, 'invalid_request', 'Provide at least one of name, avatar_url, locale');
  return out;
}

export async function updateUserProfile(d1: D1DatabaseLike, user: UserRecord, input: ProfileInput): Promise<UserRecord> {
  const next = {
    name: input.name !== undefined ? input.name : user.name,
    avatar_url: input.avatar_url !== undefined ? input.avatar_url : user.avatar_url,
    locale: input.locale ?? user.locale,
  };
  const now = nowIso();
  await d1.prepare('UPDATE users SET name = ?, avatar_url = ?, locale = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .bind(next.name, next.avatar_url, next.locale, now, user.id).run();
  return { ...user, ...next, updated_at: now };
}

// ---------------------------------------------------------------------------
// Activity log (account events; never secrets or private content)
// ---------------------------------------------------------------------------

export interface ActivityEntry {
  id: number;
  action: string;
  detail: Record<string, unknown> | null;
  user_agent: string | null;
  created_at: string;
}

export async function logActivity(
  d1: D1DatabaseLike,
  userId: string,
  action: string,
  detail: Record<string, unknown> | null = null,
  request?: Request,
): Promise<void> {
  try {
    await d1.prepare('INSERT INTO user_activity (user_id, action, detail, user_agent, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(userId, action, detail ? JSON.stringify(detail) : null, request ? userAgent(request) : null, nowIso()).run();
  } catch (err) {
    // Auditing must not break the user's action, but failures are surfaced in logs.
    console.error('user_activity insert failed:', err instanceof Error ? err.message : 'unknown');
  }
}

function parseDetail(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : null;
  } catch {
    return null;
  }
}

export async function listActivity(d1: D1DatabaseLike, userId: string, limit = 50): Promise<ActivityEntry[]> {
  const n = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
  const { results } = await d1.prepare('SELECT * FROM user_activity WHERE user_id = ? ORDER BY id DESC LIMIT ?').bind(userId, n).all<Row>();
  return (results ?? []).map(r => ({
    id: Number(r.id),
    action: str(r, 'action'),
    detail: parseDetail(strOrNull(r, 'detail')),
    user_agent: strOrNull(r, 'user_agent'),
    created_at: str(r, 'created_at'),
  }));
}

// ---------------------------------------------------------------------------
// Export and deletion
// ---------------------------------------------------------------------------

async function rows(d1: D1DatabaseLike, sql: string, ...params: unknown[]): Promise<Row[]> {
  const { results } = await d1.prepare(sql).bind(...params).all<Row>();
  return results ?? [];
}

/** Everything stored about the member, without secrets or token hashes. */
export async function exportAccount(d1: D1DatabaseLike, user: UserRecord): Promise<Record<string, unknown>> {
  return {
    exported_at: nowIso(),
    user,
    identities: await rows(d1, 'SELECT provider, email, created_at FROM user_identities WHERE user_id = ?', user.id),
    sessions: await rows(d1, 'SELECT id, created_at, last_seen_at, expires_at, user_agent FROM member_sessions WHERE user_id = ?', user.id),
    api_keys: await rows(d1, 'SELECT id, prefix, name, scopes, created_at, expires_at, last_used_at, revoked_at, replaced_by FROM user_api_keys WHERE user_id = ?', user.id),
    subscriptions: await rows(d1, 'SELECT plan, status, current_period_end, created_at, updated_at FROM subscriptions WHERE user_id = ?', user.id),
    billing_orders: await rows(d1, 'SELECT code, plan, months, amount_vnd, status, expires_at, paid_at, amount_paid, created_at FROM billing_orders WHERE user_id = ? ORDER BY created_at DESC', user.id),
    emails: await rows(d1, 'SELECT kind, status, created_at FROM email_log WHERE user_id = ? ORDER BY id DESC', user.id),
    activity: await listActivity(d1, user.id, 200),
    referral: await exportReferralData(d1, user.id),
  };
}

/**
 * Deletes the account: credentials, identities and activity are removed and the profile is scrubbed.
 * Billing orders are retained (accounting record) but no longer linked to a live email address. Referral
 * data: national-ID images and the payout profile are deleted, and a mailbox that ever paid is remembered
 * as a hash so re-registering never makes it a "never paid" referee again (`env` reaches the KYC bucket).
 */
export async function deleteAccount(d1: D1DatabaseLike, user: UserRecord, env: RuntimeEnv = {}): Promise<void> {
  await prepareReferralAccountDeletion(d1, env, user);
  const now = nowIso();
  const res = await d1.prepare(
    `UPDATE users SET email = ?, email_verified_at = NULL, name = NULL, avatar_url = NULL, deleted_at = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`
  ).bind(`deleted+${user.id}@deleted.invalid`, now, now, user.id).run();
  if (!res.meta?.changes) throw new AppError(404, 'not_found', 'Account not found');
  await d1.prepare('DELETE FROM member_sessions WHERE user_id = ?').bind(user.id).run();
  await d1.prepare('DELETE FROM user_identities WHERE user_id = ?').bind(user.id).run();
  await d1.prepare('UPDATE user_api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?').bind(now, user.id).run();
  await d1.prepare('UPDATE login_tokens SET used_at = COALESCE(used_at, ?) WHERE user_id = ? OR email = ?').bind(now, user.id, user.email).run();
  await d1.prepare('DELETE FROM user_activity WHERE user_id = ?').bind(user.id).run();
  await d1.prepare("UPDATE email_log SET to_email = '' WHERE user_id = ?").bind(user.id).run();
  await scrubReferralAccountData(d1, user.id);
}
