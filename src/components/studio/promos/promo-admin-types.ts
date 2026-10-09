// Client view of an admin promo code (`/api/v1/admin/promo-codes`) and the form <-> API mapping.
import { isRecord, list, n, nn, s, sn } from '../referrals/referral-admin-kit';

export const PRODUCTS = [
  { id: 'membership', label: 'Membership' },
  { id: 'booking', label: 'Consultation' },
  { id: 'course', label: 'Courses' },
] as const;
export const PLANS = ['knowledges', 'ai', 'combo', 'community'] as const;
export const MONTHS = [1, 3, 6, 12] as const;

export interface PromoStats { redeemed: number; reserved: number; revenue_vnd: number; revenue_usd_cents: number; discount_vnd: number; discount_usd_cents: number }

export interface AdminPromo {
  id: string; code: string; percent: number; status: string; label: string | null; note: string | null;
  starts_at: string | null; ends_at: string | null; max_uses: number | null; once_per_customer: boolean;
  products: string[] | null; plans: string[] | null; course_ids: string[] | null; min_months: number | null; card_cycles: number;
  remaining_uses: number | null; stats: PromoStats; created_at: string;
}

const strs = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);

export function toPromo(r: Record<string, unknown>): AdminPromo {
  const st = isRecord(r.stats) ? r.stats : {};
  return {
    id: s(r, 'id'), code: s(r, 'code'), percent: n(r, 'percent'), status: s(r, 'status'), label: sn(r, 'label'), note: sn(r, 'note'),
    starts_at: sn(r, 'starts_at'), ends_at: sn(r, 'ends_at'), max_uses: nn(r, 'max_uses'), once_per_customer: r.once_per_customer !== false,
    products: strs(r.products), plans: strs(r.plans), course_ids: strs(r.course_ids), min_months: nn(r, 'min_months'), card_cycles: n(r, 'card_cycles') || 1,
    remaining_uses: nn(r, 'remaining_uses'), created_at: s(r, 'created_at'),
    stats: {
      redeemed: n(st, 'redeemed'), reserved: n(st, 'reserved'), revenue_vnd: n(st, 'revenue_vnd'), revenue_usd_cents: n(st, 'revenue_usd_cents'),
      discount_vnd: n(st, 'discount_vnd'), discount_usd_cents: n(st, 'discount_usd_cents'),
    },
  };
}

export const toPromos = (v: unknown): AdminPromo[] => list(v).map(toPromo);

/** Editable form state; empty strings mean "no limit". Dates are local `datetime-local` values. */
export interface PromoForm {
  code: string; percent: string; label: string; note: string; starts_at: string; ends_at: string; max_uses: string;
  once_per_customer: boolean; products: string[]; plans: string[]; course_ids: string; min_months: string; card_cycles: string;
}

export const EMPTY_FORM: PromoForm = {
  code: '', percent: '10', label: '', note: '', starts_at: '', ends_at: '', max_uses: '', once_per_customer: true,
  products: [], plans: [], course_ids: '', min_months: '', card_cycles: '1',
};

/** ISO → `YYYY-MM-DDTHH:mm` in the browser's zone (what `<input type="datetime-local">` shows). */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formFromPromo(p: AdminPromo): PromoForm {
  return {
    code: p.code, percent: String(p.percent), label: p.label ?? '', note: p.note ?? '', starts_at: toLocalInput(p.starts_at), ends_at: toLocalInput(p.ends_at),
    max_uses: p.max_uses === null ? '' : String(p.max_uses), once_per_customer: p.once_per_customer, products: p.products ?? [], plans: p.plans ?? [],
    course_ids: (p.course_ids ?? []).join(', '), min_months: p.min_months === null ? '' : String(p.min_months), card_cycles: String(p.card_cycles),
  };
}

/** Form → API body (the server validates every field again). */
export function bodyFromForm(f: PromoForm): Record<string, unknown> {
  const int = (v: string) => (v.trim() === '' ? null : Number(v));
  const date = (v: string) => (v ? new Date(v).toISOString() : null);
  const courses = f.course_ids.split(/[\s,]+/).map(x => x.trim()).filter(Boolean);
  return {
    code: f.code.trim(), percent: Number(f.percent), label: f.label.trim() || null, note: f.note.trim() || null,
    starts_at: date(f.starts_at), ends_at: date(f.ends_at), max_uses: int(f.max_uses), once_per_customer: f.once_per_customer,
    products: f.products.length ? f.products : null, plans: f.plans.length ? f.plans : null, course_ids: courses.length ? courses : null,
    min_months: int(f.min_months), card_cycles: Number(f.card_cycles) || 1,
  };
}
