import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import type { Row } from '../members/runtime';
import { membersRuntime, str } from '../members/runtime';

/**
 * Best-effort push to dewee so a cached gate decision is dropped as soon as a member's access changes
 * (`POST {DEWEE_GATEWAY_URL}/v1/channels/instances/{DEWEE_CHANNEL_INSTANCE_ID}/access/invalidate`, body
 * `{ sender_id }`). Live checks stay the source of truth: a failed push only means dewee waits for its cache
 * TTL. Skipped silently when the env is incomplete; never throws and never logs the token.
 */

/** Kept short: pushes are best effort and may run inline when no `waitUntil` is available. */
const PUSH_TIMEOUT_MS = 2000;

/** Cloudflare `ctx.waitUntil`, so work continues after the response is sent. */
export type WaitUntil = (promise: Promise<unknown>) => void;

interface PushConfig {
  url: string;
  token: string;
  instance: string;
}

function pushConfig(env: RuntimeEnv): PushConfig | null {
  const url = (env.DEWEE_GATEWAY_URL ?? '').trim().replace(/\/+$/, '');
  const token = (env.DEWEE_GATEWAY_TOKEN ?? '').trim();
  const instance = (env.DEWEE_CHANNEL_INSTANCE_ID ?? '').trim();
  if (!url || !token || !instance) return null;
  return { url, token, instance };
}

export function channelAccessPushConfigured(env: RuntimeEnv): boolean {
  return pushConfig(env) !== null;
}

export interface InvalidateResult {
  sent: number;
  failed: number;
}

/** Tells dewee to forget cached decisions for the given sender ids. Returns null when pushes are not configured. */
export async function invalidateSenders(env: RuntimeEnv, senderIds: string[]): Promise<InvalidateResult | null> {
  const cfg = pushConfig(env);
  if (!cfg) return null;
  const endpoint = `${cfg.url}/v1/channels/instances/${encodeURIComponent(cfg.instance)}/access/invalidate`;
  // One request per sender, all in parallel: the slowest push bounds the total wait at PUSH_TIMEOUT_MS.
  const settled = await Promise.allSettled(senderIds.map(async senderId => {
    const res = await membersRuntime.fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender_id: senderId }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`dewee access invalidate answered ${res.status}`);
  }));
  const out: InvalidateResult = { sent: 0, failed: 0 };
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      out.sent += 1;
      continue;
    }
    out.failed += 1;
    const reason: unknown = r.reason;
    // Status text or error name only: never the request, so the token cannot reach the logs.
    console.warn('dewee access invalidate failed:', reason instanceof Error ? (reason.name === 'Error' ? reason.message : reason.name) : 'unknown');
  }
  return out;
}

/** Invalidates every channel identity linked to the user. */
export async function invalidateUserChannelAccess(d1: D1DatabaseLike, env: RuntimeEnv, userId: string): Promise<InvalidateResult | null> {
  if (!channelAccessPushConfigured(env)) return null;
  try {
    const { results } = await d1.prepare('SELECT external_id FROM channel_identities WHERE user_id = ? ORDER BY linked_at').bind(userId).all<Row>();
    const ids = (results ?? []).map(r => str(r, 'external_id')).filter(Boolean);
    return ids.length ? await invalidateSenders(env, ids) : { sent: 0, failed: 0 };
  } catch (err) {
    console.warn('dewee access invalidate lookup failed:', err instanceof Error ? err.message : 'unknown');
    return null;
  }
}

/** Runs a push after the response when the runtime allows it (waitUntil), otherwise inline. Never rejects. */
export async function deferChannelAccessPush(
  work: Promise<InvalidateResult | null>, waitUntil?: WaitUntil,
): Promise<void> {
  const safe = work.catch(() => null);
  if (waitUntil) waitUntil(safe);
  else await safe;
}
