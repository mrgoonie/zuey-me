import { useState } from 'react';
import { btn, btnPrimary, field } from '../referrals/referral-admin-kit';
import type { PromoForm } from './promo-admin-types';
import { MONTHS, PLANS, PRODUCTS } from './promo-admin-types';

interface Props {
  initial: PromoForm;
  /** Editing an existing code (the code name is locked once it was used; the server enforces it). */
  editing: boolean;
  busy: boolean;
  onSubmit: (form: PromoForm) => void;
  onCancel: () => void;
}

const label = 'grid gap-1 text-[11px] text-stone-400 min-w-0';

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter(v => v !== value) : [...list, value];
}

/** Create / edit form for one promo code. Empty limits mean "no restriction". */
export function PromoCodeForm({ initial, editing, busy, onSubmit, onCancel }: Props) {
  const [f, setF] = useState<PromoForm>(initial);
  const set = <K extends keyof PromoForm>(k: K, v: PromoForm[K]) => setF(prev => ({ ...prev, [k]: v }));

  return (
    <form
      className="border border-amber-400/40 rounded-xl p-4 space-y-3 text-xs text-stone-300"
      onSubmit={e => { e.preventDefault(); onSubmit(f); }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <label className={label}>Code
          <input className={`${field} font-mono uppercase`} value={f.code} onChange={e => set('code', e.target.value.toUpperCase())} required maxLength={32} placeholder="LAUNCH30" />
        </label>
        <label className={label}>Percent off (1–100)
          <input className={field} type="number" min={1} max={100} value={f.percent} onChange={e => set('percent', e.target.value)} required />
        </label>
        <label className={label}>Label (internal)
          <input className={field} value={f.label} onChange={e => set('label', e.target.value)} maxLength={120} placeholder="KOL An — Oct 2026" />
        </label>
        <label className={label}>Starts (optional)
          <input className={field} type="datetime-local" value={f.starts_at} onChange={e => set('starts_at', e.target.value)} />
        </label>
        <label className={label}>Ends (optional)
          <input className={field} type="datetime-local" value={f.ends_at} onChange={e => set('ends_at', e.target.value)} />
        </label>
        <label className={label}>Total uses (empty = unlimited)
          <input className={field} type="number" min={1} value={f.max_uses} onChange={e => set('max_uses', e.target.value)} />
        </label>
      </div>

      <fieldset className="flex flex-wrap gap-3 items-center">
        <legend className="text-[11px] text-stone-400 mb-1">Products (none ticked = all)</legend>
        {PRODUCTS.map(p => (
          <label key={p.id} className="flex items-center gap-1.5"><input type="checkbox" checked={f.products.includes(p.id)} onChange={() => set('products', toggle(f.products, p.id))} />{p.label}</label>
        ))}
      </fieldset>
      <fieldset className="flex flex-wrap gap-3 items-center">
        <legend className="text-[11px] text-stone-400 mb-1">Membership plans (none ticked = all)</legend>
        {PLANS.map(p => (
          <label key={p} className="flex items-center gap-1.5"><input type="checkbox" checked={f.plans.includes(p)} onChange={() => set('plans', toggle(f.plans, p))} />{p}</label>
        ))}
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className={label}>Min SePay prepaid months
          <select className={field} value={f.min_months} onChange={e => set('min_months', e.target.value)}>
            <option value="">any</option>
            {MONTHS.map(m => <option key={m} value={m}>{m}+</option>)}
          </select>
        </label>
        <label className={label}>Card (Dodo) months discounted
          <input className={field} type="number" min={1} max={24} value={f.card_cycles} onChange={e => set('card_cycles', e.target.value)} />
        </label>
        <label className={label}>Course ids (comma separated, empty = all)
          <input className={`${field} font-mono`} value={f.course_ids} onChange={e => set('course_ids', e.target.value)} />
        </label>
      </div>

      <label className="flex items-center gap-1.5"><input type="checkbox" checked={f.once_per_customer} onChange={e => set('once_per_customer', e.target.checked)} />Once per customer (account / mailbox)</label>
      <label className={label}>Note
        <textarea className={field} rows={2} value={f.note} onChange={e => set('note', e.target.value)} maxLength={1000} />
      </label>
      <p className="text-[11px] text-stone-500">Never stacks with a referral or member discount: the larger percent applies (a tie keeps the referral). A 100% code makes the order free and activates it at once.</p>
      <div className="flex gap-2">
        <button type="submit" className={btnPrimary} disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create code'}</button>
        <button type="button" className={btn} onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
