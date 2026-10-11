/**
 * Small pure helpers shared by the funnel events (auth, checkout, booking) so components send the
 * same, PII-free values everywhere.
 */

const REASON_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** An error code as an event reason: lower-case snake case only (API codes, `/login?error=`), else `unknown`. */
export function failureReason(code: string | null | undefined): string {
  return typeof code === 'string' && REASON_RE.test(code) ? code : 'unknown';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days between now and a slot start (0 for today or an unreadable date): coarse on purpose. */
export function daysAhead(startIso: string, nowMs: number): number {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start) || start <= nowMs) return 0;
  return Math.floor((start - nowMs) / DAY_MS);
}

/** `value`/`currency` for an event when the amount is known: VND as-is, USD from cents. */
export function moneyProps(amount: number | null | undefined, currency: 'VND' | 'USD'): { value?: number; currency?: string } {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return {};
  return { value: currency === 'USD' ? Math.round(amount) / 100 : amount, currency };
}
