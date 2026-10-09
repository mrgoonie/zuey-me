/**
 * Anti-abuse signals for paid courses: per-user rate limits (lesson reads, media URLs, quiz
 * submissions) and location sightings that flag likely account sharing for admin review.
 */
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { raiseAccountFlag } from '../members/account-flags';
import type { Row } from '../members/runtime';
import { DAY_MS, clientIp, iso, membersRuntime, sha256Hex, str } from '../members/runtime';

export const RATE_LIMITS = {
  /** Paid lesson bodies per user per hour (a human reads far fewer). */
  lesson: { limit: 120, windowSeconds: 3_600 },
  /** Signed media URLs per user per hour. */
  media: { limit: 240, windowSeconds: 3_600 },
  /** Quiz submissions per user per 10 minutes. */
  quiz: { limit: 60, windowSeconds: 600 },
  /** Checkout attempts per user per hour. */
  checkout: { limit: 10, windowSeconds: 3_600 },
  /** Public promo code lookups per network per 10 minutes (slows code guessing). */
  promoQuote: { limit: 30, windowSeconds: 600 },
} as const;
export type RateLimitName = keyof typeof RATE_LIMITS;

/** Distinct networks in 24 hours / countries in 24 hours that raise an account-sharing flag. */
export const SHARING_IP_THRESHOLD = 6;
export const SHARING_COUNTRY_THRESHOLD = 3;

export async function requestIpHash(env: RuntimeEnv, request: Request): Promise<string | null> {
  const ip = clientIp(request);
  return ip ? sha256Hex(`ip:${ip}:${env.MEMBER_HASH_SALT ?? ''}`) : null;
}

/** Two-letter country from Cloudflare (`cf-ipcountry`); null locally or for Tor (T1) / unknown (XX). */
export function requestCountry(request: Request): string | null {
  const c = (request.headers.get('cf-ipcountry') ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : null;
}

/** Fixed-window counter; throws 429 `rate_limited` with retry_after once the window is used up. */
export async function consumeRateLimit(d1: D1DatabaseLike, name: RateLimitName, subject: string): Promise<void> {
  const { limit, windowSeconds } = RATE_LIMITS[name];
  const nowSec = Math.floor(membersRuntime.now() / 1000);
  const windowStart = nowSec - (nowSec % windowSeconds);
  const key = `${name}:${subject}`;
  await d1.prepare(
    `INSERT INTO rate_counters (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (key) DO UPDATE SET count = CASE WHEN rate_counters.window_start = excluded.window_start THEN rate_counters.count + 1 ELSE 1 END,
       window_start = excluded.window_start`
  ).bind(key, windowStart).run();
  const row = await d1.prepare('SELECT count FROM rate_counters WHERE key = ?').bind(key).first<Row>();
  if (Number(row?.count ?? 0) > limit) {
    throw new AppError(429, 'rate_limited', 'Too many requests; slow down and try again shortly', { retry_after: windowStart + windowSeconds - nowSec });
  }
}

function saigonDay(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/**
 * Records where a signed-in learner reads from and flags the account when it is used from many
 * networks or countries within a day. Never throws: signals must not break reading.
 */
export async function recordLearnerSignal(d1: D1DatabaseLike, env: RuntimeEnv, userId: string, request: Request): Promise<void> {
  try {
    const ip = await requestIpHash(env, request);
    if (!ip) return;
    const nowMs = membersRuntime.now();
    const now = iso(nowMs);
    await d1.prepare(
      `INSERT INTO account_signals (user_id, day, ip_hash, country, first_seen, last_seen, hits) VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (user_id, day, ip_hash) DO UPDATE SET last_seen = excluded.last_seen, hits = account_signals.hits + 1,
         country = COALESCE(excluded.country, account_signals.country)`
    ).bind(userId, saigonDay(nowMs), ip.slice(0, 32), requestCountry(request), now, now).run();
    const since = iso(nowMs - DAY_MS);
    const stats = await d1.prepare(
      'SELECT COUNT(DISTINCT ip_hash) AS ips, COUNT(DISTINCT country) AS countries FROM account_signals WHERE user_id = ? AND last_seen > ?'
    ).bind(userId, since).first<Row>();
    const ips = Number(stats?.ips ?? 0);
    const countries = Number(stats?.countries ?? 0);
    if (ips >= SHARING_IP_THRESHOLD || countries >= SHARING_COUNTRY_THRESHOLD) {
      const { results } = await d1.prepare('SELECT DISTINCT country FROM account_signals WHERE user_id = ? AND last_seen > ? AND country IS NOT NULL').bind(userId, since).all<Row>();
      await raiseAccountFlag(d1, userId, 'multi_location', { networks_24h: ips, countries_24h: (results ?? []).map(r => str(r, 'country')) });
    }
  } catch (err) {
    console.error('learner signal failed:', err instanceof Error ? err.message : 'unknown');
  }
}
