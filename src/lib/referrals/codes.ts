import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import type { Row } from '../members/runtime';
import { isUniqueViolation, num, numOrNull, nowIso, str, strOrNull } from '../members/runtime';
import { normalizeEmail } from '../members/users';

export interface ReferralProfile {
  user_id: string;
  code: string;
  discount_percent: number;
  admin_rate_override: number | null;
  admin_enabled: boolean;
  locked_at: string | null;
  lock_reason: string | null;
  leaderboard_opt_out: boolean;
  tier_rate: number;
  tier_count_90d: number;
  tier_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Referral codes are lowercase alphanumerics, 6–16 characters (links are `/r/{code}`). */
export const REFERRAL_CODE_RE = /^[a-z0-9]{6,16}$/;
const CODE_LENGTH = 8;
const CODE_ATTEMPTS = 5;

export function rowToReferralProfile(row: Row): ReferralProfile {
  return {
    user_id: str(row, 'user_id'),
    code: str(row, 'code'),
    discount_percent: num(row, 'discount_percent'),
    admin_rate_override: numOrNull(row, 'admin_rate_override'),
    admin_enabled: num(row, 'admin_enabled') === 1,
    locked_at: strOrNull(row, 'locked_at'),
    lock_reason: strOrNull(row, 'lock_reason'),
    leaderboard_opt_out: num(row, 'leaderboard_opt_out') === 1,
    tier_rate: num(row, 'tier_rate'),
    tier_count_90d: num(row, 'tier_count_90d'),
    tier_updated_at: strOrNull(row, 'tier_updated_at'),
    created_at: str(row, 'created_at'),
    updated_at: str(row, 'updated_at'),
  };
}

/** Trimmed, lower-cased code, or null when it cannot be a referral code (never reaches SQL otherwise). */
export function normalizeReferralCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toLowerCase();
  return REFERRAL_CODE_RE.test(code) ? code : null;
}

/** Random 8-character code from an alphabet without look-alike characters (0/o, 1/l/i). */
export function generateReferralCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

export async function getReferralProfile(d1: D1DatabaseLike, userId: string): Promise<ReferralProfile | null> {
  const row = await d1.prepare('SELECT * FROM referral_profiles WHERE user_id = ?').bind(userId).first<Row>();
  return row ? rowToReferralProfile(row) : null;
}

export async function getReferralProfileByCode(d1: D1DatabaseLike, rawCode: unknown): Promise<ReferralProfile | null> {
  const code = normalizeReferralCode(rawCode);
  if (!code) return null;
  const row = await d1.prepare('SELECT * FROM referral_profiles WHERE code = ?').bind(code).first<Row>();
  return row ? rowToReferralProfile(row) : null;
}

/** Returns the member's referral profile, creating it with a fresh unique code on first use (race-safe). */
export async function ensureReferralProfile(d1: D1DatabaseLike, userId: string): Promise<ReferralProfile> {
  const existing = await getReferralProfile(d1, userId);
  if (existing) return existing;
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const now = nowIso();
    try {
      // A promo code may already own this name (promo and referral codes share the checkout field).
      const code = generateReferralCode();
      const res = await d1.prepare(
        `INSERT INTO referral_profiles (user_id, code, created_at, updated_at)
         SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM promo_codes WHERE code = upper(?))`
      ).bind(userId, code, now, now, code).run();
      if (res.meta?.changes === 0) continue;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Either a concurrent request created this member's profile, or the random code collided: retry.
      const raced = await getReferralProfile(d1, userId);
      if (raced) return raced;
      continue;
    }
    const created = await getReferralProfile(d1, userId);
    if (created) return created;
  }
  throw new AppError(500, 'internal_error', 'Could not allocate a referral code');
}

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Canonical mailbox for self-referral and previous-customer checks: lower-cased, `+tag` removed, and for
 * Gmail dots removed and googlemail.com folded into gmail.com. Null when the input is not an email.
 */
export function normalizeEmailForSelfCheck(raw: unknown): string | null {
  const email = normalizeEmail(raw);
  if (!email) return null;
  const at = email.lastIndexOf('@');
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return local ? `${local}@${domain}` : null;
}
