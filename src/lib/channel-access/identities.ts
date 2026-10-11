import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { Row } from '../members/runtime';
import { iso, isUniqueViolation, membersRuntime, str } from '../members/runtime';
import { getEntitlements } from '../members/subscriptions';
import type { LinkTokenError, LinkTokenPayload } from './link-token';
import { verifyLinkToken } from './link-token';

/** A member's linked chat-channel account (provider = dewee channel_type, external_id = dewee sender_id). */
export interface ChannelIdentity {
  provider: string;
  external_id: string;
  user_id: string;
  linked_at: string;
  source: 'link_token' | 'community_backfill';
}

function toIdentity(r: Row): ChannelIdentity {
  return {
    provider: str(r, 'provider'),
    external_id: str(r, 'external_id'),
    user_id: str(r, 'user_id'),
    linked_at: str(r, 'linked_at'),
    source: str(r, 'source') === 'community_backfill' ? 'community_backfill' : 'link_token',
  };
}

export async function findChannelIdentity(d1: D1DatabaseLike, provider: string, externalId: string): Promise<ChannelIdentity | null> {
  const row = await d1.prepare('SELECT * FROM channel_identities WHERE provider = ? AND external_id = ?').bind(provider, externalId).first<Row>();
  return row ? toIdentity(row) : null;
}

export async function listChannelIdentities(d1: D1DatabaseLike, userId: string): Promise<ChannelIdentity[]> {
  const { results } = await d1.prepare('SELECT * FROM channel_identities WHERE user_id = ? ORDER BY linked_at').bind(userId).all<Row>();
  return (results ?? []).map(toIdentity);
}

/** Removes one of the member's own links; false when it does not exist or belongs to someone else. */
export async function unlinkChannelIdentity(d1: D1DatabaseLike, userId: string, provider: string, externalId: string): Promise<boolean> {
  const res = await d1.prepare('DELETE FROM channel_identities WHERE provider = ? AND external_id = ? AND user_id = ?').bind(provider, externalId, userId).run();
  return (res.meta?.changes ?? 0) > 0;
}

const TOKEN_ERRORS: Record<LinkTokenError, { status: number; code: string; message: string }> = {
  malformed: { status: 400, code: 'invalid_link_token', message: 'The link token is invalid' },
  bad_signature: { status: 400, code: 'invalid_link_token', message: 'The link token is invalid' },
  unsupported_version: { status: 400, code: 'invalid_link_token', message: 'The link token version is not supported' },
  expired: { status: 400, code: 'link_token_expired', message: 'The link token has expired; ask the bot for a new link' },
  unsupported_channel: { status: 400, code: 'unsupported_channel', message: 'This chat channel cannot be linked' },
};

function requireLinkSecret(env: RuntimeEnv): string {
  const secret = (env.CHANNEL_LINK_TOKEN_SECRET ?? '').trim();
  if (secret.length < 32) {
    throw new AppError(503, 'channel_link_unconfigured', 'Account linking is not configured', { missing: ['CHANNEL_LINK_TOKEN_SECRET'] });
  }
  return secret;
}

/** Verifies a dewee link token; throws AppError (400/503) when it cannot be used. */
export async function readLinkToken(env: RuntimeEnv, token: unknown): Promise<LinkTokenPayload> {
  const secret = requireLinkSecret(env);
  const result = await verifyLinkToken(token, secret, membersRuntime.now());
  if (!result.ok) {
    const e = TOKEN_ERRORS[result.error];
    throw new AppError(e.status, e.code, e.message);
  }
  // With the gated bot's instance configured, a token minted for any other dewee channel instance is refused.
  const instance = (env.DEWEE_CHANNEL_INSTANCE_ID ?? '').trim();
  if (instance && result.payload.channel_instance !== instance) {
    throw new AppError(400, 'invalid_link_token', 'This link was issued for a different bot');
  }
  return result.payload;
}

export type LinkPreviewState = 'ready' | 'linked_to_you' | 'linked_elsewhere' | 'used';

/** What /connect shows for a valid token before the member confirms. */
export async function linkPreview(d1: D1DatabaseLike, payload: LinkTokenPayload, userId: string): Promise<LinkPreviewState> {
  const existing = await findChannelIdentity(d1, payload.channel_type, payload.sender_id);
  if (existing && existing.user_id !== userId) return 'linked_elsewhere';
  const used = await d1.prepare('SELECT 1 AS used FROM channel_link_nonces WHERE nonce = ?').bind(payload.nonce).first<Row>();
  if (existing) return 'linked_to_you';
  return used ? 'used' : 'ready';
}

export interface LinkOutcome {
  provider: string;
  external_id: string;
  sender_username: string | null;
  /** True when this sender was already linked to the same member (nothing changed). */
  already_linked: boolean;
  /** Whether the member's plans currently allow chatting with the agent. */
  entitled: boolean;
}

/**
 * Redeems a link token for the signed-in member: the token's single sender is linked to `userId`. A sender
 * already linked to another member is refused (one external id never maps to two users); the same member
 * gets an idempotent success. Each token nonce is consumed once, so a replayed token is rejected.
 */
export async function redeemLinkToken(
  d1: D1DatabaseLike, env: RuntimeEnv, token: unknown, userId: string, isAdmin: boolean,
): Promise<LinkOutcome> {
  const payload = await readLinkToken(env, token);
  const provider = payload.channel_type;
  const externalId = payload.sender_id;

  const existing = await findChannelIdentity(d1, provider, externalId);
  if (existing && existing.user_id !== userId) {
    throw new AppError(409, 'channel_linked_elsewhere', 'This chat account is already linked to another zuey.me account');
  }

  const now = membersRuntime.now();
  // Prune nonces of tokens that can no longer verify.
  await d1.prepare('DELETE FROM channel_link_nonces WHERE expires_at < ?').bind(iso(now)).run();
  const consumeNonce = d1.prepare('INSERT INTO channel_link_nonces (nonce, provider, external_id, user_id, used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(payload.nonce, provider, externalId, userId, iso(now), iso(payload.exp * 1000));
  let alreadyLinked = existing !== null;
  try {
    if (existing) await consumeNonce.run();
    // Nonce and link commit together: a failed link never burns the token, and a used token never links.
    else {
      await d1.batch([consumeNonce, d1.prepare("INSERT INTO channel_identities (provider, external_id, user_id, linked_at, source) VALUES (?, ?, ?, ?, 'link_token')")
        .bind(provider, externalId, userId, iso(now))]);
    }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const used = await d1.prepare('SELECT 1 AS used FROM channel_link_nonces WHERE nonce = ?').bind(payload.nonce).first<Row>();
    if (used || existing) throw new AppError(409, 'link_token_used', 'This link was already used; ask the bot for a new link');
    // A concurrent request linked the sender first: succeed only if it was this member (and still consume the token).
    const winner = await findChannelIdentity(d1, provider, externalId);
    if (!winner) throw err;
    if (winner.user_id !== userId) {
      throw new AppError(409, 'channel_linked_elsewhere', 'This chat account is already linked to another zuey.me account');
    }
    try {
      await consumeNonce.run();
    } catch (nonceErr) {
      if (isUniqueViolation(nonceErr)) throw new AppError(409, 'link_token_used', 'This link was already used; ask the bot for a new link');
      throw nonceErr;
    }
    alreadyLinked = true;
  }
  const entitled = isAdmin || (await getEntitlements(d1, userId)).entitlements.includes('agent_chat');
  return { provider, external_id: externalId, sender_username: payload.sender_username, already_linked: alreadyLinked, entitled };
}
