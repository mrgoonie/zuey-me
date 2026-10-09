import type { D1DatabaseLike } from '../../db/store';
import type { Row } from '../members/runtime';
import { nowIso, sha256Hex } from '../members/runtime';

/**
 * Hashes of canonical mailboxes whose account was deleted after paying. Deletion scrubs the email from
 * `users`, and SePay orders carry no email, so without this a previous customer could delete their account,
 * sign up again through a friend's link and be treated as a never-paid referee.
 *
 * Plain SHA-256 with a fixed domain-separation prefix rather than the MEMBER_HASH_SALT pattern used for IPs:
 * eligibility is checked on paths that have no runtime env (fraud snapshots, quotes), and a salt rotation
 * would silently forget every recorded customer. The stored value is still not the email itself.
 */
const DOMAIN = 'zuey-referral-paid-email:v1:';

export async function paidEmailHash(canonicalEmail: string): Promise<string> {
  return sha256Hex(`${DOMAIN}${canonicalEmail}`);
}

export async function recordPaidEmail(d1: D1DatabaseLike, canonicalEmail: string): Promise<void> {
  await d1.prepare('INSERT OR IGNORE INTO referral_paid_email_hashes (email_hash, created_at) VALUES (?, ?)')
    .bind(await paidEmailHash(canonicalEmail), nowIso()).run();
}

export async function isPaidEmailRecorded(d1: D1DatabaseLike, canonicalEmail: string): Promise<boolean> {
  const row = await d1.prepare('SELECT 1 AS hit FROM referral_paid_email_hashes WHERE email_hash = ?').bind(await paidEmailHash(canonicalEmail)).first<Row>();
  return row !== null;
}
