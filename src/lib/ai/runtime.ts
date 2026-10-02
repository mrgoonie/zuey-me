/**
 * Injectable side effects and env parsing for Zuey AI chat, the sandbox fetch proxy and their tests.
 * Edge-safe: Web APIs only.
 */
import type { RuntimeEnv } from '../../env';
import type { SocketOpener } from './dewee-client';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export const aiRuntime: {
  fetch: FetchFn;
  now: () => number;
  /** Gateway transport override (tests); undefined uses the production WebSocket opener. */
  openSocket: SocketOpener | undefined;
  /** How often a streaming reply checks the database for a stop request from another request. */
  stopPollMs: number;
} = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  openSocket: undefined,
  stopPollMs: 1500,
};

export const DEFAULT_MONTHLY_REQUEST_LIMIT = 300;
const SAIGON_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Quota month key 'YYYY-MM' in Asia/Saigon (UTC+7, no DST). */
export function saigonMonth(ms: number): string {
  return new Date(ms + SAIGON_OFFSET_MS).toISOString().slice(0, 7);
}

/** AI_MONTHLY_REQUEST_LIMIT: positive integer requests per member per month (default 300). */
export function monthlyRequestLimit(env: RuntimeEnv): number {
  const raw = (env.AI_MONTHLY_REQUEST_LIMIT ?? '').trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_MONTHLY_REQUEST_LIMIT;
  const n = Number(raw);
  return n >= 1 && Number.isSafeInteger(n) ? n : DEFAULT_MONTHLY_REQUEST_LIMIT;
}

/** AI_EST_COST_USD_PER_MTOK: blended USD per million tokens for cost estimates; null when unset. */
export function costRateUsdPerMTok(env: RuntimeEnv): number | null {
  const raw = (env.AI_EST_COST_USD_PER_MTOK ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function estimateCostCents(totalTokens: number, rate: number | null): number {
  if (rate === null || totalTokens <= 0) return 0;
  return Math.round((totalTokens / 1_000_000) * rate * 100 * 10_000) / 10_000;
}

export function nowIso(): string {
  return new Date(aiRuntime.now()).toISOString();
}
