import { useCallback, useEffect, useState } from 'react';
import { Flash, Pill, adminApi, btn, btnDanger, btnPrimary, field, list, n, nn, panel, row, s, sn, usd, vnd, when, type FlashMessage } from '../referrals/referral-admin-kit';
import { PromoCodeForm } from './PromoCodeForm';
import type { AdminPromo, PromoForm } from './promo-admin-types';
import { EMPTY_FORM, bodyFromForm, formFromPromo, toPromo, toPromos } from './promo-admin-types';

interface Redemption {
  id: string; source_kind: string; source_code: string | null; user_email: string | null; currency: string;
  amount_before: number; amount_due: number; amount_paid: number | null; status: string; created_at: string;
}

const money = (currency: string, v: number | null) => (currency === 'USD' ? usd(v) : vnd(v));

function limits(p: AdminPromo): string {
  const parts = [
    p.products ? p.products.join('/') : 'all products',
    p.plans ? `plans ${p.plans.join('/')}` : null,
    p.min_months ? `≥${p.min_months} months` : null,
    p.course_ids ? `${p.course_ids.length} course(s)` : null,
    p.card_cycles > 1 ? `card ${p.card_cycles} months` : null,
    p.once_per_customer ? 'once per customer' : 'reusable per customer',
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Studio "Promo codes": create, edit, disable, and see uses, revenue and the orders behind each code. */
export function PromoCodesPanel() {
  const [items, setItems] = useState<AdminPromo[]>([]);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<AdminPromo | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [busy, setBusy] = useState<string | null>('load');
  const [message, setMessage] = useState<FlashMessage>(null);

  const load = useCallback(async () => {
    setBusy('load');
    const r = await adminApi(`/api/v1/admin/promo-codes${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
    setBusy(null);
    if (r.ok) setItems(toPromos(r.data.promo_codes)); else setMessage({ kind: 'error', text: r.message });
  }, [q]);
  useEffect(() => { void load(); }, [load]);

  const save = async (form: PromoForm) => {
    const target = editing;
    if (!target) return;
    setBusy('save'); setMessage(null);
    const r = target === 'new'
      ? await adminApi('/api/v1/admin/promo-codes', { method: 'POST', body: bodyFromForm(form) })
      : await adminApi(`/api/v1/admin/promo-codes/${encodeURIComponent(target.id)}`, { method: 'PATCH', body: bodyFromForm(form) });
    setBusy(null);
    if (!r.ok) { setMessage({ kind: 'error', text: r.message }); return; }
    const saved = toPromo(r.data);
    setItems(prev => (target === 'new' ? [saved, ...prev] : prev.map(i => (i.id === saved.id ? saved : i))));
    setEditing(null);
    setMessage({ kind: 'ok', text: `${saved.code} saved.` });
  };

  const setStatus = async (p: AdminPromo, status: 'active' | 'disabled') => {
    setBusy(p.id); setMessage(null);
    const r = await adminApi(`/api/v1/admin/promo-codes/${encodeURIComponent(p.id)}`, { method: 'PATCH', body: { status } });
    setBusy(null);
    if (!r.ok) { setMessage({ kind: 'error', text: `${p.code}: ${r.message}` }); return; }
    const saved = toPromo(r.data);
    setItems(prev => prev.map(i => (i.id === saved.id ? saved : i)));
  };

  const toggleOrders = async (p: AdminPromo) => {
    if (open === p.id) { setOpen(null); return; }
    setOpen(p.id); setRedemptions([]);
    const r = await adminApi(`/api/v1/admin/promo-codes/${encodeURIComponent(p.id)}/redemptions`);
    if (!r.ok) { setMessage({ kind: 'error', text: r.message }); return; }
    setRedemptions(list(r.data.redemptions).map(x => ({
      id: s(x, 'id'), source_kind: s(x, 'source_kind'), source_code: sn(x, 'source_code'), user_email: sn(x, 'user_email'), currency: s(x, 'currency'),
      amount_before: n(x, 'amount_before'), amount_due: n(x, 'amount_due'), amount_paid: nn(x, 'amount_paid'), status: s(x, 'status'), created_at: s(x, 'created_at'),
    })));
  };

  return (
    <section aria-labelledby="promo-codes" className={panel}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="promo-codes" className="font-bold text-white text-sm">Promo codes · {items.length}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <input className={field} placeholder="Search code or label" value={q} onChange={e => setQ(e.target.value)} aria-label="Search promo codes" />
          <button type="button" className={btnPrimary} onClick={() => setEditing('new')} disabled={editing !== null}>New code</button>
        </div>
      </div>
      <Flash message={message} />
      {editing && (
        <PromoCodeForm
          key={editing === 'new' ? 'new' : editing.id} initial={editing === 'new' ? EMPTY_FORM : formFromPromo(editing)} editing={editing !== 'new'}
          busy={busy === 'save'} onSubmit={form => void save(form)} onCancel={() => setEditing(null)}
        />
      )}
      {busy !== 'load' && items.length === 0 && <p className="text-xs text-stone-400">No promo codes yet.</p>}
      <ul className="space-y-3">
        {items.map(p => (
          <li key={p.id} className={row}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <span className="font-mono font-bold text-white text-sm">{p.code}</span>
                <span className="font-bold text-amber-300">−{p.percent}%</span>
                <Pill status={p.status === 'active' ? 'enabled' : 'cancelled'}>{p.status}</Pill>
                {p.label && <span className="text-stone-400 truncate">{p.label}</span>}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={btn} onClick={() => setEditing(p)} disabled={editing !== null}>Edit</button>
                <button type="button" className={btn} onClick={() => void toggleOrders(p)}>{open === p.id ? 'Hide orders' : 'Orders'}</button>
                {p.status === 'active'
                  ? <button type="button" className={btnDanger} onClick={() => void setStatus(p, 'disabled')} disabled={busy === p.id}>Disable</button>
                  : <button type="button" className={btn} onClick={() => void setStatus(p, 'active')} disabled={busy === p.id}>Enable</button>}
              </div>
            </div>
            <p className="text-stone-400">{limits(p)} · {p.starts_at ? `from ${when(p.starts_at)}` : 'no start'} · {p.ends_at ? `until ${when(p.ends_at)}` : 'no end'}</p>
            <p className="tabular-nums">
              Used {p.stats.redeemed}{p.stats.reserved > 0 && ` (+${p.stats.reserved} open checkout${p.stats.reserved > 1 ? 's' : ''})`}
              {p.max_uses !== null && ` of ${p.max_uses} · ${p.remaining_uses ?? 0} left`}
              {' · '}revenue {vnd(p.stats.revenue_vnd)} + {usd(p.stats.revenue_usd_cents)} · discount given {vnd(p.stats.discount_vnd)} + {usd(p.stats.discount_usd_cents)}
            </p>
            {open === p.id && (
              <ul className="mt-2 space-y-1 border-t border-stone-800 pt-2">
                {redemptions.length === 0 && <li className="text-stone-500">No orders yet.</li>}
                {redemptions.map(r => (
                  <li key={r.id} className="flex flex-wrap gap-x-3 gap-y-1 tabular-nums">
                    <span className="font-mono text-white">{r.source_code ?? r.source_kind}</span>
                    <span>{r.source_kind.replace('_', ' ')}</span>
                    <span className="text-stone-400">{r.user_email ?? '—'}</span>
                    <span>{money(r.currency, r.amount_before)} → {money(r.currency, r.amount_due)}</span>
                    {r.amount_paid !== null && <span>paid {money(r.currency, r.amount_paid)}</span>}
                    <Pill status={r.status === 'redeemed' ? 'paid' : r.status === 'reserved' ? 'pending' : 'cancelled'}>{r.status}</Pill>
                    <span className="text-stone-500">{when(r.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
