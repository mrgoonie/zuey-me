import { useCallback, useEffect, useState } from 'react';
import { Flash, Pill, adminApi, btn, btnDanger, btnPrimary, field, isRecord, list, n, panel, row, s, sn, usd, when, type FlashMessage } from './referral-admin-kit';

type Decision = 'approve' | 'reject' | 'reverse';
const STATUSES = ['review', 'pending', 'approved', 'reversed', 'blocked', ''] as const;

interface Commission {
  id: string; source_kind: string; source_id: string; referrer_email: string; referee_email: string | null;
  base_amount_cents: number; commission_percent: number; commission_cents: number; status: string;
  review_reasons: string[]; hold_until: string; paid_at: string | null;
}

function toCommission(r: Record<string, unknown>): Commission {
  return {
    id: s(r, 'id'), source_kind: s(r, 'source_kind'), source_id: s(r, 'source_id'), referrer_email: s(r, 'referrer_email'),
    referee_email: sn(r, 'referee_email'), base_amount_cents: n(r, 'base_amount_cents'), commission_percent: n(r, 'commission_percent'),
    commission_cents: n(r, 'commission_cents'), status: s(r, 'status'),
    review_reasons: Array.isArray(r.review_reasons) ? r.review_reasons.filter((x): x is string => typeof x === 'string') : [],
    hold_until: s(r, 'hold_until'), paid_at: sn(r, 'paid_at'),
  };
}

/** Which decisions the server accepts for a status (reject: review/pending; reverse: anything not final). */
function allowed(status: string): Decision[] {
  if (status === 'review') return ['approve', 'reject', 'reverse'];
  if (status === 'pending') return ['reject', 'reverse'];
  if (status === 'approved') return ['reverse'];
  return [];
}

const CONFIRM: Record<Decision, string | null> = {
  approve: null,
  reject: 'Reject this commission? It becomes blocked and is never paid.',
  reverse: 'Reverse this commission? Any credited amount is taken back from the referrer’s balance.',
};

/** Commission queue (default: soft fraud signals in `review`) with approve / reject / reverse and a note. */
export function CommissionReviewPanel() {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('review');
  const [items, setItems] = useState<Commission[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>('load');
  const [message, setMessage] = useState<FlashMessage>(null);

  const load = useCallback(async () => {
    setBusy('load');
    const r = await adminApi(`/api/v1/admin/referrals/commissions?limit=100${status ? `&status=${status}` : ''}`);
    setBusy(null);
    if (r.ok) setItems(list(r.data.commissions).map(toCommission)); else setMessage({ kind: 'error', text: r.message });
  }, [status]);
  useEffect(() => { void load(); }, [load]);

  const decide = async (c: Commission, decision: Decision) => {
    const prompt = CONFIRM[decision];
    if (prompt && !window.confirm(prompt)) return;
    setBusy(c.id); setMessage(null);
    const note = notes[c.id]?.trim();
    const r = await adminApi(`/api/v1/admin/referrals/commissions/${encodeURIComponent(c.id)}/${decision}`, { method: 'POST', body: note ? { note } : {} });
    setBusy(null);
    if (!r.ok) { setMessage({ kind: 'error', text: `${c.id}: ${r.message}` }); return; }
    const next = r.data.commission;
    setMessage({ kind: 'ok', text: `${c.referee_email ?? c.id}: ${s(r.data, 'outcome').replace(/_/g, ' ')}.` });
    if (isRecord(next)) {
      const updated = toCommission({ ...next, referrer_email: c.referrer_email });
      setItems(prev => (status && updated.status !== status ? prev.filter(i => i.id !== c.id) : prev.map(i => (i.id === c.id ? updated : i))));
    }
  };

  return (
    <section aria-labelledby="ref-review" className={panel}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="ref-review" className="font-bold text-white text-sm">Commissions · {items.length}</h3>
        <label className="flex items-center gap-2 text-xs text-stone-400">Status
          <select className={field} value={status} onChange={e => setStatus(STATUSES.find(x => x === e.target.value) ?? 'review')}>
            {STATUSES.map(x => <option key={x} value={x}>{x || 'all'}</option>)}
          </select>
        </label>
      </div>
      <Flash message={message} />
      {busy !== 'load' && items.length === 0 && <p className="text-xs text-stone-400">Nothing here.</p>}
      <ul className="space-y-3">
        {items.map(c => {
          const working = busy === c.id;
          const actions = allowed(c.status);
          return (
            <li key={c.id} className={row} aria-busy={working}>
              <div className="flex flex-wrap items-center gap-2">
                <Pill status={c.status} />
                {c.review_reasons.map(reason => <Pill key={reason} status="review">{reason}</Pill>)}
              </div>
              <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1">
                <div><dt className="inline text-stone-500">Referrer: </dt><dd className="inline break-all text-white">{c.referrer_email || '—'}</dd></div>
                <div><dt className="inline text-stone-500">Referee: </dt><dd className="inline break-all">{c.referee_email ?? '—'}</dd></div>
                <div><dt className="inline text-stone-500">Source: </dt><dd className="inline font-mono break-all">{c.source_kind} · {c.source_id}</dd></div>
                <div><dt className="inline text-stone-500">Commission: </dt><dd className="inline">{usd(c.commission_cents)} ({c.commission_percent}% of {usd(c.base_amount_cents)})</dd></div>
                <div><dt className="inline text-stone-500">Paid: </dt><dd className="inline">{when(c.paid_at)}</dd></div>
                <div><dt className="inline text-stone-500">Hold until: </dt><dd className="inline">{when(c.hold_until || null)}</dd></div>
              </dl>
              {actions.length > 0 && (
                <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                  <label htmlFor={`note-${c.id}`} className="sr-only">Note for {c.id}</label>
                  <input id={`note-${c.id}`} className={`${field} flex-1`} maxLength={500} placeholder="Note for the audit log (optional)" value={notes[c.id] ?? ''} disabled={working} onChange={e => setNotes({ ...notes, [c.id]: e.target.value })} />
                  <div className="flex gap-2">
                    {actions.includes('approve') && <button type="button" className={btnPrimary} disabled={working} onClick={() => void decide(c, 'approve')}>Approve</button>}
                    {actions.includes('reject') && <button type="button" className={btn} disabled={working} onClick={() => void decide(c, 'reject')}>Reject</button>}
                    {actions.includes('reverse') && <button type="button" className={btnDanger} disabled={working} onClick={() => void decide(c, 'reverse')}>Reverse</button>}
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
