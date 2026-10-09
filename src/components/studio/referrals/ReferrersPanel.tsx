import { useCallback, useEffect, useState } from 'react';
import { Flash, Pill, adminApi, btn, btnDanger, btnPrimary, field, list, n, nn, panel, row, s, sn, usd, type FlashMessage } from './referral-admin-kit';

interface Referrer {
  email: string; name: string | null; code: string; rate: number; tier_rate: number; tier_count_90d: number;
  admin_rate_override: number | null; admin_enabled: boolean; discount_percent: number; locked_at: string | null;
  lock_reason: string | null; balance_cents: number; held_cents: number; referred_count: number;
}

function toReferrer(r: Record<string, unknown>): Referrer {
  return {
    email: s(r, 'email'), name: sn(r, 'name'), code: s(r, 'code'), rate: n(r, 'rate'), tier_rate: n(r, 'tier_rate'), tier_count_90d: n(r, 'tier_count_90d'),
    admin_rate_override: nn(r, 'admin_rate_override'), admin_enabled: r.admin_enabled === true, discount_percent: n(r, 'discount_percent'),
    locked_at: sn(r, 'locked_at'), lock_reason: sn(r, 'lock_reason'), balance_cents: n(r, 'balance_cents'), held_cents: n(r, 'held_cents'),
    referred_count: n(r, 'referred_count'),
  };
}

/** Referrer search with rate override, admin enablement (refer without a plan) and lock / unlock. */
export function ReferrersPanel() {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Referrer[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { override: string; reason: string }>>({});
  const [enableEmail, setEnableEmail] = useState('');
  const [busy, setBusy] = useState<string | null>('search');
  const [message, setMessage] = useState<FlashMessage>(null);

  const search = useCallback(async (query: string) => {
    setBusy('search');
    const r = await adminApi(`/api/v1/admin/referrals/referrers?q=${encodeURIComponent(query.trim())}&limit=50`);
    setBusy(null);
    if (r.ok) setItems(list(r.data.referrers).map(toReferrer)); else setMessage({ kind: 'error', text: r.message });
  }, []);
  useEffect(() => { void search(''); }, [search]);

  const update = async (email: string, body: Record<string, unknown>, done: string) => {
    setBusy(email); setMessage(null);
    const r = await adminApi(`/api/v1/admin/referrals/referrers/${encodeURIComponent(email)}`, { method: 'PATCH', body });
    setBusy(null);
    if (!r.ok) { setMessage({ kind: 'error', text: `${email}: ${r.message}` }); return; }
    const next = toReferrer(r.data);
    setItems(prev => (prev.some(i => i.email === next.email) ? prev.map(i => (i.email === next.email ? next : i)) : [next, ...prev]));
    setDrafts(d => ({ ...d, [email]: { override: '', reason: '' } }));
    setMessage({ kind: 'ok', text: `${email}: ${done}.` });
  };

  const draft = (email: string) => drafts[email] ?? { override: '', reason: '' };
  const setDraft = (email: string, patch: Partial<{ override: string; reason: string }>) => setDrafts(d => ({ ...d, [email]: { ...draft(email), ...patch } }));

  return (
    <section aria-labelledby="ref-referrers" className={panel}>
      <h3 id="ref-referrers" className="font-bold text-white text-sm">Referrers</h3>
      <form className="flex flex-col sm:flex-row gap-2" onSubmit={e => { e.preventDefault(); void search(q); }}>
        <label htmlFor="ref-search" className="sr-only">Search referrers</label>
        <input id="ref-search" className={`${field} flex-1`} placeholder="Email, name or code" value={q} onChange={e => setQ(e.target.value)} />
        <button type="submit" className={btn} disabled={busy !== null}>{busy === 'search' ? 'Searching…' : 'Search'}</button>
      </form>
      <form className="flex flex-col sm:flex-row gap-2" onSubmit={e => { e.preventDefault(); if (enableEmail.trim()) void update(enableEmail.trim(), { admin_enabled: true }, 'enabled'); }}>
        <label htmlFor="ref-enable" className="sr-only">Enable a member by email</label>
        <input id="ref-enable" type="email" className={`${field} flex-1`} placeholder="Enable a member without a plan: email" value={enableEmail} onChange={e => setEnableEmail(e.target.value)} />
        <button type="submit" className={btn} disabled={busy !== null || enableEmail.trim() === ''}>Enable</button>
      </form>
      <Flash message={message} />
      {busy !== 'search' && items.length === 0 && <p className="text-xs text-stone-400">No referrers found.</p>}
      <ul className="space-y-3">
        {items.map(i => {
          const d = draft(i.email);
          const working = busy === i.email;
          const override = d.override.trim() === '' ? null : Number(d.override);
          return (
            <li key={i.email} className={row} aria-busy={working}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-white font-semibold break-all">{i.email}</span>
                {i.name && <span className="text-stone-400">{i.name}</span>}
                <span className="font-mono text-stone-400">{i.code}</span>
                {i.admin_enabled && <Pill status="enabled">admin-enabled</Pill>}
                {i.locked_at && <Pill status="locked">locked</Pill>}
              </div>
              <p className="break-words">
                R {i.rate}% (tier {i.tier_rate}% · {i.tier_count_90d} in 90d{i.admin_rate_override !== null ? ` · override ${i.admin_rate_override}%` : ''}) · split d {i.discount_percent}% ·
                referred {i.referred_count} · balance {usd(i.balance_cents)} · held {usd(i.held_cents)}
              </p>
              {i.lock_reason && <p className="text-rose-300">Lock reason: {i.lock_reason}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5">Override %
                  <input className={`${field} w-16`} inputMode="numeric" placeholder={i.admin_rate_override?.toString() ?? '—'} value={d.override} disabled={working} onChange={e => setDraft(i.email, { override: e.target.value })} />
                </label>
                <button type="button" className={btnPrimary} disabled={working || override === null || !Number.isInteger(override)} onClick={() => void update(i.email, { admin_rate_override: override }, `override set to ${override}%`)}>Set</button>
                <button type="button" className={btn} disabled={working || i.admin_rate_override === null} onClick={() => void update(i.email, { admin_rate_override: null }, 'override cleared')}>Clear override</button>
                <button type="button" className={btn} disabled={working} onClick={() => void update(i.email, { admin_enabled: !i.admin_enabled }, i.admin_enabled ? 'admin enablement removed' : 'enabled')}>
                  {i.admin_enabled ? 'Remove enablement' : 'Enable'}
                </button>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                {i.locked_at ? (
                  <button type="button" className={btn} disabled={working} onClick={() => void update(i.email, { locked: false }, 'unlocked')}>Unlock</button>
                ) : (
                  <>
                    <label htmlFor={`lock-${i.email}`} className="sr-only">Lock reason for {i.email}</label>
                    <input id={`lock-${i.email}`} className={`${field} flex-1`} maxLength={500} placeholder="Lock reason (required to lock)" value={d.reason} disabled={working} onChange={e => setDraft(i.email, { reason: e.target.value })} />
                    <button type="button" className={btnDanger} disabled={working || d.reason.trim() === ''} onClick={() => void update(i.email, { locked: true, lock_reason: d.reason.trim() }, 'locked')}>Lock</button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
