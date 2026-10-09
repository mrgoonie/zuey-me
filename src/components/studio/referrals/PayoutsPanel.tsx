import { useCallback, useEffect, useMemo, useState } from 'react';
import { recentMonths } from '../../referral/referral-api';
import { Flash, Pill, adminApi, btn, btnDanger, btnPrimary, field, isRecord, list, n, nn, panel, row, s, sn, usd, vnd, when, type FlashMessage } from './referral-admin-kit';

const STATUSES = ['', 'pending', 'paid', 'cancelled'] as const;

interface Payout {
  id: string; period: string; method: string; email: string | null; name: string | null;
  gross_cents: number; deduction_bp: number; deduction_cents: number; net_cents: number; net_vnd: number | null;
  status: string; transaction_ref: string | null; paid_at: string | null; payee: Record<string, unknown>;
}

function toPayout(r: Record<string, unknown>): Payout {
  return {
    id: s(r, 'id'), period: s(r, 'period'), method: s(r, 'method'), email: sn(r, 'email'), name: sn(r, 'name'),
    gross_cents: n(r, 'gross_cents'), deduction_bp: n(r, 'deduction_bp'), deduction_cents: n(r, 'deduction_cents'), net_cents: n(r, 'net_cents'),
    net_vnd: nn(r, 'net_vnd'), status: s(r, 'status'), transaction_ref: sn(r, 'transaction_ref'), paid_at: sn(r, 'paid_at'),
    payee: isRecord(r.payee) ? r.payee : {},
  };
}

/**
 * Monthly payouts: the day-1 close of a period with payee details, CSV export, mark paid (with the bank or
 * PayPal transaction reference; emails the referrer) and cancel (returns the gross to the balance).
 */
export function PayoutsPanel() {
  // The day-1 close books the month that just ended, so the previous month is the one to pay.
  const months = useMemo(() => recentMonths(Date.now(), 13), []);
  const [period, setPeriod] = useState(months[1]);
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('');
  const [items, setItems] = useState<Payout[]>([]);
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>('load');
  const [message, setMessage] = useState<FlashMessage>(null);

  const load = useCallback(async () => {
    setBusy('load');
    const r = await adminApi(`/api/v1/admin/referrals/payouts?period=${period}${status ? `&status=${status}` : ''}`);
    setBusy(null);
    if (r.ok) setItems(list(r.data.payouts).map(toPayout)); else setMessage({ kind: 'error', text: r.message });
  }, [period, status]);
  useEffect(() => { void load(); }, [load]);

  const act = async (p: Payout, action: 'paid' | 'cancel') => {
    const ref = refs[p.id]?.trim() ?? '';
    if (action === 'cancel' && !window.confirm(`Cancel the ${p.period} payout to ${p.email ?? p.id}? The gross returns to their balance.`)) return;
    setBusy(p.id); setMessage(null);
    const r = await adminApi(`/api/v1/admin/referrals/payouts/${encodeURIComponent(p.id)}/${action}`, { method: 'POST', body: action === 'paid' ? { transaction_ref: ref } : {} });
    setBusy(null);
    if (!r.ok) { setMessage({ kind: 'error', text: `${p.email ?? p.id}: ${r.message}` }); return; }
    const email = sn(r.data, 'email');
    setMessage({ kind: 'ok', text: `${p.email ?? p.id}: ${s(r.data, 'outcome').replace(/_/g, ' ')}${email ? ` · email ${email}` : ''}.` });
    if (isRecord(r.data.payout)) {
      const next = toPayout({ ...r.data.payout, email: p.email, name: p.name, payee: p.payee });
      setItems(prev => prev.map(i => (i.id === p.id ? next : i)));
    }
  };

  const pending = items.filter(i => i.status === 'pending');
  const totalNet = pending.reduce((sum, i) => sum + i.net_cents, 0);

  return (
    <section aria-labelledby="ref-payouts" className={panel}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="ref-payouts" className="font-bold text-white text-sm">Payouts · {items.length}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-stone-400">Period
            <select className={field} value={period} onChange={e => setPeriod(e.target.value)}>{months.map(m => <option key={m} value={m}>{m}</option>)}</select>
          </label>
          <label className="flex items-center gap-2 text-xs text-stone-400">Status
            <select className={field} value={status} onChange={e => setStatus(STATUSES.find(x => x === e.target.value) ?? '')}>{STATUSES.map(x => <option key={x} value={x}>{x || 'all'}</option>)}</select>
          </label>
          <a className={btn} href={`/api/v1/admin/referrals/payouts.csv?period=${period}`} download>CSV</a>
        </div>
      </div>
      <p className="text-[11px] text-stone-500">Unpaid: {pending.length} · net {usd(totalNet)}. Pay manually between the 1st and the 10th, then record the transaction reference.</p>
      <Flash message={message} />
      {busy !== 'load' && items.length === 0 && <p className="text-xs text-stone-400">No payouts for {period}.</p>}
      <ul className="space-y-3">
        {items.map(p => {
          const working = busy === p.id;
          const payee = p.payee;
          return (
            <li key={p.id} className={row} aria-busy={working}>
              <div className="flex flex-wrap items-center gap-2">
                <Pill status={p.status} />
                <span className="text-white font-semibold break-all">{p.email ?? '—'}</span>
                {p.name && <span className="text-stone-400">{p.name}</span>}
                <span className="text-stone-400">{p.method === 'paypal' ? 'PayPal' : 'VN bank'}</span>
              </div>
              <p className="break-words">
                {p.method === 'paypal'
                  ? <>PayPal <span className="text-white">{s(payee, 'paypal_email') || '—'}</span></>
                  : <><span className="text-white">{s(payee, 'full_name') || '—'}</span> · {s(payee, 'bank_name') || '—'} · <span className="font-mono">{s(payee, 'bank_account') || '—'}</span> · CCCD <span className="font-mono">{s(payee, 'national_id') || '—'}</span></>}
              </p>
              <p className="tabular-nums">
                Gross {usd(p.gross_cents)} − {(p.deduction_bp / 100).toFixed(2)}% ({usd(p.deduction_cents)}) = <span className="text-white font-semibold">{usd(p.net_cents)}</span>
                {p.method === 'vn_bank' && <> ≈ <span className="text-white font-semibold">{vnd(p.net_vnd)}</span></>}
                {p.transaction_ref && <> · ref <span className="font-mono">{p.transaction_ref}</span></>}
                {p.paid_at && <> · paid {when(p.paid_at)}</>}
              </p>
              {p.status === 'pending' && (
                <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                  <label htmlFor={`payout-ref-${p.id}`} className="sr-only">Transaction reference for {p.email}</label>
                  <input id={`payout-ref-${p.id}`} className={`${field} flex-1`} maxLength={200} placeholder="Transaction reference (required)" value={refs[p.id] ?? ''} disabled={working} onChange={e => setRefs({ ...refs, [p.id]: e.target.value })} />
                  <div className="flex gap-2">
                    <button type="button" className={btnPrimary} disabled={working || !(refs[p.id] ?? '').trim()} onClick={() => void act(p, 'paid')}>{working ? 'Working…' : 'Mark paid'}</button>
                    <button type="button" className={btnDanger} disabled={working} onClick={() => void act(p, 'cancel')}>Cancel</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
