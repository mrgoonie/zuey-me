import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { emailChangeNoticeEmail, emailChangeVerifyEmail, magicLinkEmail, sendLoggedEmail } from './email';
import type { Row } from './runtime';
import {
  clientIp, iso, isUniqueViolation, membersRuntime, randomId, randomSecret, safeNextPath, sha256Hex, siteUrl, str, strOrNull,
} from './runtime';
import { createMemberSession } from './session';
import type { UserRecord } from './users';
import { findOrCreateVerifiedUser, getUserByEmail, getUserById, logActivity, normalizeEmail } from './users';

export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
const TOKEN_MINUTES = LOGIN_TOKEN_TTL_MS / 60000;
export const RATE_WINDOW_MS = 15 * 60 * 1000;
export const MAX_LINKS_PER_EMAIL = 5;
export const MAX_LINKS_PER_IP = 20;

type TokenPurpose = 'magic_link' | 'email_change';

interface LoginTokenRow {
  id: string;
  purpose: TokenPurpose;
  email: string;
  user_id: string | null;
  next_path: string | null;
}

function requireEmailConfigured(env: RuntimeEnv, feature: string): void {
  if (!env.RESEND_API_KEY) {
    throw new AppError(503, 'email_unconfigured', `${feature} is unavailable: RESEND_API_KEY is not configured`, { missing: ['RESEND_API_KEY'] });
  }
}

/** Salted SHA-256 of the client IP (never the raw IP); null when the request carries none. */
export async function ipHash(env: RuntimeEnv, request: Request): Promise<string | null> {
  const ip = clientIp(request);
  return ip ? sha256Hex(`ip:${ip}:${env.MEMBER_HASH_SALT ?? ''}`) : null;
}

async function countSince(d1: D1DatabaseLike, column: 'email' | 'ip_hash' | 'user_id', purpose: TokenPurpose, value: string): Promise<number> {
  const since = iso(membersRuntime.now() - RATE_WINDOW_MS);
  const row = await d1.prepare(`SELECT COUNT(*) AS n FROM login_tokens WHERE purpose = ? AND ${column} = ? AND created_at > ?`)
    .bind(purpose, value, since).first<Row>();
  return Number(row?.n ?? 0);
}

function rateLimited(): never {
  throw new AppError(429, 'rate_limited', 'Too many requests; please wait a few minutes and try again', { retry_after_seconds: RATE_WINDOW_MS / 1000 });
}

async function insertToken(
  d1: D1DatabaseLike,
  input: { purpose: TokenPurpose; email: string; userId: string | null; ipHash: string | null; next: string | null },
): Promise<{ id: string; token: string }> {
  const token = randomSecret(32);
  const now = membersRuntime.now();
  const id = randomId('lt');
  await d1.prepare(
    `INSERT INTO login_tokens (id, token_hash, purpose, email, user_id, ip_hash, next_path, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, await sha256Hex(token), input.purpose, input.email, input.userId, input.ipHash, input.next, iso(now), iso(now + LOGIN_TOKEN_TTL_MS)).run();
  return { id, token };
}

async function invalidateToken(d1: D1DatabaseLike, id: string): Promise<void> {
  await d1.prepare('UPDATE login_tokens SET used_at = COALESCE(used_at, ?) WHERE id = ?').bind(iso(membersRuntime.now()), id).run();
}

/** Atomically marks an unexpired, unused token of the given purpose as used. */
async function consumeToken(d1: D1DatabaseLike, rawToken: unknown, purpose: TokenPurpose): Promise<LoginTokenRow> {
  const invalid = new AppError(400, 'invalid_token', 'This link is invalid, already used or expired. Request a new one.');
  if (typeof rawToken !== 'string' || rawToken.length < 20 || rawToken.length > 200) throw invalid;
  const nowStr = iso(membersRuntime.now());
  const row = await d1.prepare('SELECT * FROM login_tokens WHERE token_hash = ? AND purpose = ?').bind(await sha256Hex(rawToken), purpose).first<Row>();
  if (!row || row.used_at || str(row, 'expires_at') <= nowStr) throw invalid;
  const res = await d1.prepare('UPDATE login_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?')
    .bind(nowStr, str(row, 'id'), nowStr).run();
  if (res.meta?.changes !== 1) throw invalid;
  return {
    id: str(row, 'id'),
    purpose,
    email: str(row, 'email'),
    user_id: strOrNull(row, 'user_id'),
    next_path: strOrNull(row, 'next_path'),
  };
}

// ---------------------------------------------------------------------------
// Magic link sign-in
// ---------------------------------------------------------------------------

/** Emails a 15-minute single-use sign-in link. Rate limited per email and per client IP. */
export async function requestMagicLink(
  d1: D1DatabaseLike, env: RuntimeEnv, request: Request, body: Record<string, unknown>,
): Promise<{ expires_in_minutes: number }> {
  requireEmailConfigured(env, 'Magic link sign-in');
  const email = normalizeEmail(body.email);
  if (!email) throw new AppError(400, 'invalid_field', 'email must be a valid email address', { field: 'email' });
  const hashedIp = await ipHash(env, request);
  if ((await countSince(d1, 'email', 'magic_link', email)) >= MAX_LINKS_PER_EMAIL) rateLimited();
  if (hashedIp && (await countSince(d1, 'ip_hash', 'magic_link', hashedIp)) >= MAX_LINKS_PER_IP) rateLimited();

  const next = safeNextPath(body.next);
  const { id, token } = await insertToken(d1, { purpose: 'magic_link', email, userId: null, ipHash: hashedIp, next });
  const link = `${siteUrl(env)}/login/verify?token=${encodeURIComponent(token)}`;
  const sent = await sendLoggedEmail(d1, env, { key: `magic_link:${id}`, kind: 'magic_link', to: email, userId: null, ...magicLinkEmail(link, TOKEN_MINUTES) });
  if (sent.status !== 'sent') {
    await invalidateToken(d1, id);
    throw new AppError(502, 'email_failed', 'Could not send the sign-in email right now; please try again shortly');
  }
  return { expires_in_minutes: TOKEN_MINUTES };
}

/** Consumes a magic link: verifies the email, creates the account if needed and opens a session. */
export async function consumeMagicLink(
  d1: D1DatabaseLike, request: Request, rawToken: unknown,
): Promise<{ user: UserRecord; created: boolean; next: string; sessionToken: string }> {
  const token = await consumeToken(d1, rawToken, 'magic_link');
  const { user, created } = await findOrCreateVerifiedUser(d1, { email: token.email });
  const { token: sessionToken } = await createMemberSession(d1, user.id, request);
  await logActivity(d1, user.id, created ? 'account.created' : 'login', { method: 'magic_link' }, request);
  return { user, created, next: safeNextPath(token.next_path), sessionToken };
}

// ---------------------------------------------------------------------------
// Email change (verify the new address, notify the old one)
// ---------------------------------------------------------------------------

export async function requestEmailChange(
  d1: D1DatabaseLike, env: RuntimeEnv, request: Request, user: UserRecord, rawEmail: unknown,
): Promise<{ pending_email: string; expires_in_minutes: number }> {
  requireEmailConfigured(env, 'Email change');
  const email = normalizeEmail(rawEmail);
  if (!email) throw new AppError(400, 'invalid_field', 'new_email must be a valid email address', { field: 'new_email' });
  if (email === user.email) throw new AppError(400, 'invalid_field', 'new_email is already your email', { field: 'new_email' });
  const taken = await getUserByEmail(d1, email);
  if (taken) throw new AppError(409, 'email_taken', 'That email belongs to another account');
  if ((await countSince(d1, 'user_id', 'email_change', user.id)) >= MAX_LINKS_PER_EMAIL) rateLimited();

  const { id, token } = await insertToken(d1, { purpose: 'email_change', email, userId: user.id, ipHash: await ipHash(env, request), next: null });
  const link = `${siteUrl(env)}/account/email-confirm?token=${encodeURIComponent(token)}`;
  const sent = await sendLoggedEmail(d1, env, { key: `email_change_verify:${id}`, kind: 'email_change_verify', to: email, userId: user.id, ...emailChangeVerifyEmail(link, TOKEN_MINUTES) });
  if (sent.status !== 'sent') {
    await invalidateToken(d1, id);
    throw new AppError(502, 'email_failed', 'Could not send the verification email right now; please try again shortly');
  }
  await logActivity(d1, user.id, 'email_change.requested', { new_email: email }, request);
  return { pending_email: email, expires_in_minutes: TOKEN_MINUTES };
}

/** Applies a verified email change; the token alone proves control of the new mailbox. */
export async function confirmEmailChange(
  d1: D1DatabaseLike, env: RuntimeEnv, request: Request, rawToken: unknown,
): Promise<UserRecord> {
  const token = await consumeToken(d1, rawToken, 'email_change');
  const user = token.user_id ? await getUserById(d1, token.user_id) : null;
  if (!user) throw new AppError(400, 'invalid_token', 'This link is invalid, already used or expired. Request a new one.');
  const oldEmail = user.email;
  const now = iso(membersRuntime.now());
  try {
    await d1.prepare('UPDATE users SET email = ?, email_verified_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .bind(token.email, now, now, user.id).run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, 'email_taken', 'That email now belongs to another account');
    throw err;
  }
  await logActivity(d1, user.id, 'email_change.confirmed', { old_email: oldEmail, new_email: token.email }, request);
  const notice = await sendLoggedEmail(d1, env, {
    key: `email_change_notice:${token.id}`, kind: 'email_change_notice', to: oldEmail, userId: user.id, ...emailChangeNoticeEmail(token.email),
  });
  if (notice.status !== 'sent') console.error('email change notice not delivered:', notice.status, notice.error ?? '');
  return { ...user, email: token.email, email_verified_at: now, updated_at: now };
}
