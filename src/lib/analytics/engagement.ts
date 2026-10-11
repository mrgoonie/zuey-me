/**
 * Pure helpers shared by the product engagement events (Knowledges, Reads, Zuey AI, ZueyOS, community,
 * surveys) so every component sends the same coarse, PII-free values: public slugs, counts, lengths,
 * buckets and backend metrics. Never search text, chat text, vote labels or URLs.
 */
import { containsPii } from './pii';

/** Public taxonomy slugs and keys (category, tag, label, source kind); anything else becomes `other`. */
const SLUG_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const DIGIT_RUN_RE = /\d{8,}/;

export function publicSlug(value: string | null | undefined): string {
  if (typeof value !== 'string') return 'other';
  const v = value.trim().toLowerCase();
  return SLUG_RE.test(v) && !DIGIT_RUN_RE.test(v) && !containsPii(v) ? v : 'other';
}

/** A filter value, or `all` when the filter was cleared. */
export function filterValue(value: string | null | undefined): string {
  return value === null || value === undefined || value.trim() === '' ? 'all' : publicSlug(value);
}

const HOST_RE = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Hostname of a public site (no path, query or port); `other` when it does not look like one. */
export function siteDomain(value: string | null | undefined): string {
  if (typeof value !== 'string') return 'other';
  const v = value.trim().toLowerCase().replace(/^www\./, '');
  return HOST_RE.test(v) && !containsPii(v) ? v : 'other';
}

/** Seconds the article must be visible and the share of its readable body scrolled before `article_engaged`. */
export const ENGAGED_SECONDS = 30;
export const ENGAGED_DEPTH = 50;

/** Scroll depth (0–100) rounded down to a quarter: 0, 25, 50, 75, 100. */
export function depthBucket(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.min(100, Math.floor(percent / 25) * 25);
}

/** How far the reader got through an element: 0 before its top reaches the viewport bottom, 100 at its end. */
export function scrollDepth(rect: { top: number; height: number }, viewportHeight: number): number {
  if (rect.height <= 0) return 100;
  const seen = (viewportHeight - rect.top) / rect.height;
  return Math.max(0, Math.min(100, Math.round(seen * 100)));
}

export function isEngaged(seconds: number, depthPercent: number): boolean {
  return seconds >= ENGAGED_SECONDS && depthPercent >= ENGAGED_DEPTH;
}

/** Where the Zuey AI panel runs: the /chat page, an article drawer, or a ZueyOS window. */
export type AiSurface = 'chat_page' | 'article' | 'window';

export function aiSurface(fromArticle: boolean, pathname: string): AiSurface {
  if (fromArticle) return 'article';
  return pathname.replace(/\/+$/, '') === '/chat' ? 'chat_page' : 'window';
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Backend metrics of a finished reply (`done` frame): latency, token usage and estimated cost, when present. */
export function aiReplyMetrics(data: Record<string, unknown>): {
  latency_ms?: number; prompt_tokens?: number; completion_tokens?: number; cost_cents?: number;
} {
  const usage = typeof data.usage === 'object' && data.usage !== null ? data.usage : null;
  const out: { latency_ms?: number; prompt_tokens?: number; completion_tokens?: number; cost_cents?: number } = {};
  const latency = count(data.latency_ms);
  if (latency !== undefined) out.latency_ms = Math.round(latency);
  const prompt = count(usage && 'prompt_tokens' in usage ? usage.prompt_tokens : undefined);
  if (prompt !== undefined) out.prompt_tokens = prompt;
  const completion = count(usage && 'completion_tokens' in usage ? usage.completion_tokens : undefined);
  if (completion !== undefined) out.completion_tokens = completion;
  const cost = count(data.cost_cents);
  if (cost !== undefined) out.cost_cents = cost;
  return out;
}

/** `latency_ms` of an `error` frame, when the backend sent it. */
export function aiFailureLatency(data: Record<string, unknown>): { latency_ms?: number } {
  const latency = count(data.latency_ms);
  return latency === undefined ? {} : { latency_ms: Math.round(latency) };
}

/**
 * PostHog autocapture of Core Web Vitals (LCP, CLS, FCP, INP: one `$web_vitals` event per page) and of
 * uncaught exceptions (`$exception`). Both go through the same consent gate and `before_send` scrubber as
 * every other event; network timing stays off because session replay is off.
 */
export const PERFORMANCE_CAPTURE_OPTIONS = {
  capture_performance: { web_vitals: true, network_timing: false },
  capture_exceptions: { capture_unhandled_errors: true, capture_unhandled_rejections: true, capture_console_errors: false },
} as const;
