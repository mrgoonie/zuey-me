import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { recordAdminAccess } from '../ai/chat-store';
import { AppError } from '../http';
import type { Principal } from '../members/policy';
import type { Row } from '../members/runtime';
import { str, strOrNull } from '../members/runtime';
import { logActivity } from '../members/users';
import type { ChannelIdentity } from './identities';
import { findChannelIdentity } from './identities';
import type { WaitUntil } from './invalidate';
import { deferChannelAccessPush, invalidateSenders } from './invalidate';
import type { ChannelType } from './link-token';
import { SENDER_ID_RE, SUPPORTED_CHANNEL_TYPES, isChannelType } from './link-token';

/**
 * Admin recovery for chat accounts linked to the wrong member (mistaken community backfill, a link made on
 * someone else's device, a support request from the real owner). Lookup shows who holds a sender id;
 * unlinking frees it so the real owner can link at /connect, tells the affected member only that an admin
 * unlinked it (`channel.unlinked` with `by: 'admin'`), keeps who did it and why in the admin-only
 * `admin_access_audit` log and tells dewee to re-check that sender at once.
 */

export const MAX_UNLINK_REASON_LENGTH = 500;

export interface ChannelRef {
  provider: ChannelType;
  external_id: string;
}

/**
 * Decodes a URL path segment once. Astro leaves reserved characters such as `%3A` encoded in route params,
 * so `777%3A002` must become `777:002` before validation; malformed encoding is a 400.
 */
export function decodePathParam(raw: string | undefined, field: string): string | undefined {
  if (raw === undefined) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new AppError(400, 'invalid_field', `${field} is not valid URL encoding`, { field });
  }
}

/** Validates a provider/external id pair from a path or tool arguments; throws AppError 400. */
export function parseChannelRef(provider: unknown, externalId: unknown): ChannelRef {
  if (!isChannelType(provider)) {
    throw new AppError(400, 'unsupported_channel', `provider must be one of ${SUPPORTED_CHANNEL_TYPES.join(', ')}`, { field: 'provider' });
  }
  if (typeof externalId !== 'string' || !SENDER_ID_RE.test(externalId)) {
    throw new AppError(400, 'invalid_field', 'external_id is required (letters, digits and _ . : @ + -, at most 128 characters)', { field: 'external_id' });
  }
  return { provider, external_id: externalId };
}

/** Optional free-text reason recorded in the activity log; throws AppError 400 when it is not a short string. */
export function parseUnlinkReason(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || raw.trim().length > MAX_UNLINK_REASON_LENGTH) {
    throw new AppError(400, 'invalid_field', `reason must be a string of at most ${MAX_UNLINK_REASON_LENGTH} characters`, { field: 'reason' });
  }
  return raw.trim() || null;
}

export interface ChannelIdentityHolder {
  id: string;
  email: string;
  name: string | null;
}

export interface AdminChannelIdentityView extends ChannelIdentity {
  /** The member holding the link (null only if the user row is missing, which the schema should prevent). */
  member: ChannelIdentityHolder | null;
}

async function holderOf(d1: D1DatabaseLike, userId: string): Promise<ChannelIdentityHolder | null> {
  const row = await d1.prepare('SELECT id, email, name FROM users WHERE id = ?').bind(userId).first<Row>();
  return row ? { id: str(row, 'id'), email: str(row, 'email'), name: strOrNull(row, 'name') } : null;
}

async function requireIdentity(d1: D1DatabaseLike, ref: ChannelRef): Promise<ChannelIdentity> {
  const identity = await findChannelIdentity(d1, ref.provider, ref.external_id);
  if (!identity) throw new AppError(404, 'not_found', 'This chat account is not linked to any member');
  return identity;
}

/** Admin lookup: which member holds this sender id. 404 when it is not linked. */
export async function adminGetChannelIdentity(d1: D1DatabaseLike, ref: ChannelRef): Promise<AdminChannelIdentityView> {
  const identity = await requireIdentity(d1, ref);
  return { ...identity, member: await holderOf(d1, identity.user_id) };
}

export interface AdminUnlinkOptions {
  /** The admin doing it; recorded with the reason only in the admin-only audit log, never shown to the member. */
  principal: Principal;
  reason: string | null;
  waitUntil?: WaitUntil;
}

export interface AdminUnlinkResult {
  unlinked: true;
  identity: AdminChannelIdentityView;
}

/**
 * Removes a sender's link whoever holds it. 404 when nothing is linked (a concurrent unlink counts as not
 * found). The activity row and the dewee push are best effort: once the link is gone the unlink has succeeded.
 */
export async function adminUnlinkChannelIdentity(
  d1: D1DatabaseLike, env: RuntimeEnv, ref: ChannelRef, opts: AdminUnlinkOptions,
): Promise<AdminUnlinkResult> {
  const identity = await adminGetChannelIdentity(d1, ref);
  // Bound to the holder read above, so a relink that raced in between is never removed blindly.
  const res = await d1.prepare('DELETE FROM channel_identities WHERE provider = ? AND external_id = ? AND user_id = ?')
    .bind(ref.provider, ref.external_id, identity.user_id).run();
  if ((res.meta?.changes ?? 0) === 0) throw new AppError(404, 'not_found', 'This chat account is not linked to any member');
  // The member sees only that an admin unlinked it: no admin identity, reason or admin user agent.
  await logActivity(d1, identity.user_id, 'channel.unlinked', { provider: ref.provider, external_id: ref.external_id, by: 'admin' });
  try {
    await recordAdminAccess(d1, opts.principal, 'channel.unlink',
      `channel_identity:${ref.provider}:${ref.external_id}:user=${identity.user_id}`, opts.reason ?? '');
  } catch (err) {
    console.error('admin_access_audit insert failed:', err instanceof Error ? err.message : 'unknown');
  }
  // dewee may have cached allow/deny for this sender under the old member: let it re-check now.
  await deferChannelAccessPush(invalidateSenders(env, [ref.external_id]), opts.waitUntil);
  return { unlinked: true, identity };
}
