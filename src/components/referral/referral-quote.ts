import { useCallback, useEffect, useState } from 'react';
import { applyPercent } from '../../lib/referrals/rates';
import { callApi, isRecord, numOr, records, str } from '../members/member-ui';

/** Client view of `GET /api/v1/referrals/quote`: display only, every checkout recomputes server-side. */
export interface ReferralQuoteView {
  referral: { code: string; discount_percent: number; booking_discount_percent: number; source: string; provisional: boolean } | null;
  plans: { plan: string; months: number; amount_usd_cents: number; amount_vnd: number | null; discounted_usd_cents: number; discounted_vnd: number | null }[];
  card_first_month: { plan: string; amount_usd_cents: number; discounted_usd_cents: number }[];
  booking: { amount_usd_cents: number; discounted_usd_cents: number; amount_vnd: number | null; discounted_vnd: number | null };
}

const numOrNull = (r: Record<string, unknown>, k: string): number | null => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? Number(r[k]) : null);

export function parseReferralQuote(v: unknown): ReferralQuoteView | null {
  if (!isRecord(v) || !Array.isArray(v.plans) || !isRecord(v.booking)) return null;
  const r = isRecord(v.referral) ? v.referral : null;
  const b = v.booking;
  return {
    referral: r && str(r, 'code') ? {
      code: str(r, 'code'), discount_percent: numOr(r, 'discount_percent'), booking_discount_percent: numOr(r, 'booking_discount_percent'),
      source: str(r, 'source'), provisional: r.provisional === true,
    } : null,
    plans: records(v.plans).map(p => ({
      plan: str(p, 'plan'), months: numOr(p, 'months', 1), amount_usd_cents: numOr(p, 'amount_usd_cents'), amount_vnd: numOrNull(p, 'amount_vnd'),
      discounted_usd_cents: numOr(p, 'discounted_usd_cents'), discounted_vnd: numOrNull(p, 'discounted_vnd'),
    })),
    card_first_month: records(v.card_first_month).map(c => ({
      plan: str(c, 'plan'), amount_usd_cents: numOr(c, 'amount_usd_cents'), discounted_usd_cents: numOr(c, 'discounted_usd_cents'),
    })),
    booking: {
      amount_usd_cents: numOr(b, 'amount_usd_cents'), discounted_usd_cents: numOr(b, 'discounted_usd_cents'),
      amount_vnd: numOrNull(b, 'amount_vnd'), discounted_vnd: numOrNull(b, 'discounted_vnd'),
    },
  };
}

/** Client view of `GET /api/v1/promos/quote`: a live promo code's terms (display only). */
export interface PromoQuoteView {
  code: string;
  percent: number;
  products: string[] | null;
  plans: string[] | null;
  course_ids: string[] | null;
  min_months: number | null;
  card_cycles: number;
}

const strList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);

export function parsePromoQuote(v: unknown): PromoQuoteView | null {
  if (!isRecord(v) || !str(v, 'code')) return null;
  return {
    code: str(v, 'code'), percent: numOr(v, 'percent'), products: strList(v.products), plans: strList(v.plans), course_ids: strList(v.course_ids),
    min_months: numOrNull(v, 'min_months'), card_cycles: numOr(v, 'card_cycles', 1),
  };
}

export interface PromoTargetView { product: 'membership' | 'booking' | 'course'; plan?: string; months?: number; courseId?: string }

/** Percent the typed promo gives this purchase (0 when it does not apply). Per-customer limits are checked at checkout. */
export function promoPercentFor(promo: PromoQuoteView | null, t: PromoTargetView): number {
  if (!promo) return 0;
  if (promo.products && !promo.products.includes(t.product)) return 0;
  if (t.product === 'membership') {
    if (promo.plans && (!t.plan || !promo.plans.includes(t.plan))) return 0;
    if (promo.min_months && (t.months ?? 1) < promo.min_months) return 0;
  }
  if (t.product === 'course' && promo.course_ids && (!t.courseId || !promo.course_ids.includes(t.courseId))) return 0;
  return promo.percent;
}

/** Same rounding as the server: VND discounts round down to 1,000 ₫, USD to the cent. */
export function discounted(amount: number, percent: number, currency: 'VND' | 'USD'): number {
  return applyPercent(amount, percent, currency);
}

const PROMO_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

/** Same shape as the server's `normalizeReferralCode`: 6–16 letters or digits, case-insensitive. */
export function normalizeCodeInput(raw: string): string | null {
  const code = raw.trim().toLowerCase();
  return /^[a-z0-9]{6,16}$/.test(code) ? code : null;
}

export type ApplyOutcome = 'applied' | 'bound_elsewhere' | 'not_applicable';

/**
 * How a typed code relates to the quote it produced. A bound account keeps its referrer (typed codes are
 * ignored); otherwise the typed code wins over the cookie, so any other code in the answer means it failed.
 */
export function applyOutcome(typed: string, quote: ReferralQuoteView): ApplyOutcome {
  const r = quote.referral;
  if (!r) return 'not_applicable';
  if (r.code === typed) return 'applied';
  return r.source === 'bound' ? 'bound_elsewhere' : 'not_applicable';
}

export interface ReferralQuoteState {
  quote: ReferralQuoteView | null;
  /** Typed promo code that is live (null when none or the typed code is a referral code). */
  promo: PromoQuoteView | null;
  /** Typed code that applied and must be sent as `discount_code` at checkout (null: cookie/binding or none). */
  enteredCode: string | null;
  busy: boolean;
  message: { kind: 'ok' | 'error'; text: string } | null;
  apply: (raw: string) => Promise<void>;
  clear: () => void;
}

const COPY = {
  invalid: 'Mã không hợp lệ. Mã ưu đãi gồm chữ cái, chữ số, - hoặc _.',
  promoApplied: (pct: number) => `Đã áp dụng mã ưu đãi: giảm ${pct}%. Ưu đãi không cộng dồn với mã giới thiệu — hệ thống chọn mức giảm lớn hơn.`,
  applied: (pct: number) => `Đã áp dụng mã: giảm ${pct}%.`,
  bound: (code: string) => `Tài khoản của bạn đã gắn mã giới thiệu ${code}; ưu đãi theo mã này.`,
  notApplicable: 'Mã này không áp dụng được (mã không hoạt động, là mã của bạn, hoặc tài khoản đã từng thanh toán).',
  failed: 'Không kiểm tra được mã lúc này. Vui lòng thử lại.',
};

/**
 * Loads the visitor's referral quote (cookie or account binding) on mount, and lets them type a code.
 * The page itself stays cacheable: nothing personal is rendered on the server.
 */
export function useReferralQuote(): ReferralQuoteState {
  const [quote, setQuote] = useState<ReferralQuoteView | null>(null);
  const [promo, setPromo] = useState<PromoQuoteView | null>(null);
  const [enteredCode, setEnteredCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<ReferralQuoteState['message']>(null);

  const fetchQuote = useCallback(async (code: string | null) => {
    const res = await callApi(`/api/v1/referrals/quote${code ? `?code=${encodeURIComponent(code)}` : ''}`, { cache: 'no-store' });
    return res.ok ? parseReferralQuote(res.data) : null;
  }, []);

  useEffect(() => {
    let live = true;
    void fetchQuote(null).then(q => { if (live && q) setQuote(q); });
    return () => { live = false; };
  }, [fetchQuote]);

  const apply = useCallback(async (raw: string) => {
    const upper = raw.trim().toUpperCase();
    if (PROMO_CODE_RE.test(upper)) {
      setBusy(true);
      const res = await callApi(`/api/v1/promos/quote?code=${encodeURIComponent(upper)}`, { cache: 'no-store' });
      setBusy(false);
      const found = res.ok ? parsePromoQuote(res.data) : null;
      if (found) {
        setPromo(found);
        setEnteredCode(found.code);
        setMessage({ kind: 'ok', text: COPY.promoApplied(found.percent) });
        return;
      }
      if (!res.ok && res.code !== 'promo_code_not_found') { setMessage({ kind: 'error', text: res.message }); return; }
    }
    const code = normalizeCodeInput(raw);
    if (!code) { setMessage({ kind: 'error', text: COPY.invalid }); return; }
    setPromo(null);
    setBusy(true);
    const q = await fetchQuote(code);
    setBusy(false);
    if (!q) { setMessage({ kind: 'error', text: COPY.failed }); return; }
    const outcome = applyOutcome(code, q);
    if (outcome === 'applied') {
      setQuote(q);
      setEnteredCode(q.referral?.source === 'entered' ? code : null);
      setMessage({ kind: 'ok', text: COPY.applied(q.referral?.discount_percent ?? 0) });
    } else if (outcome === 'bound_elsewhere') {
      setQuote(q);
      setEnteredCode(null);
      setMessage({ kind: 'ok', text: COPY.bound(q.referral?.code ?? '') });
    } else {
      setMessage({ kind: 'error', text: COPY.notApplicable });
    }
  }, [fetchQuote]);

  const clear = useCallback(() => {
    setEnteredCode(null);
    setPromo(null);
    setMessage(null);
    void fetchQuote(null).then(q => { if (q) setQuote(q); });
  }, [fetchQuote]);

  return { quote, promo, enteredCode, busy, message, apply, clear };
}
