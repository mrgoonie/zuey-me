import { useCallback, useEffect, useRef, useState } from 'react';
import { Flash, Pill, adminApi, btn, btnDanger, btnPrimary, field, list, panel, row, s, sn, when, type FlashMessage } from './referral-admin-kit';

const STATUSES = ['submitted', 'draft', 'verified', 'rejected', 'all'] as const;

interface Profile {
  user_id: string; email: string | null; name: string | null; method: string; status: string;
  full_name: string | null; bank_name: string | null; bank_account: string | null; national_id: string | null;
  address: string | null; paypal_email: string | null; has_id_front: boolean; has_id_back: boolean;
  reject_reason: string | null; updated_at: string;
}

function toProfile(r: Record<string, unknown>): Profile {
  return {
    user_id: s(r, 'user_id'), email: sn(r, 'email'), name: sn(r, 'name'), method: s(r, 'method'), status: s(r, 'status'),
    full_name: sn(r, 'full_name'), bank_name: sn(r, 'bank_name'), bank_account: sn(r, 'bank_account'), national_id: sn(r, 'national_id'),
    address: sn(r, 'address'), paypal_email: sn(r, 'paypal_email'), has_id_front: r.has_id_front === true, has_id_back: r.has_id_back === true,
    reject_reason: sn(r, 'reject_reason'), updated_at: s(r, 'updated_at'),
  };
}

/** Admin proxy for one ID image (no-store, audited on every view). */
const imageUrl = (userId: string, side: 'front' | 'back') =>
  `/api/v1/admin/referrals/payout-profiles/${encodeURIComponent(userId)}/id-images/${side}`;

/**
 * Payout-profile (KYC) review: details, national-ID images through the admin proxy, approve or reject with a
 * reason. Either decision deletes both images from storage on the server.
 */
export function KycReviewPanel() {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('submitted');
  const [items, setItems] = useState<Profile[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>('load');
  const [message, setMessage] = useState<FlashMessage>(null);
  const [viewer, setViewer] = useState<{ profile: Profile; side: 'front' | 'back' } | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const load = useCallback(async () => {
    setBusy('load');
    const r = await adminApi(`/api/v1/admin/referrals/payout-profiles?status=${status}`);
    setBusy(null);
    if (r.ok) setItems(list(r.data.profiles).map(toProfile)); else setMessage({ kind: 'error', text: r.message });
  }, [status]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (viewer && !dialog.open) dialog.showModal();
    if (!viewer && dialog.open) dialog.close();
  }, [viewer]);

  const decide = async (p: Profile, decision: 'approve' | 'reject') => {
    const reason = reasons[p.user_id]?.trim() ?? '';
    if (decision === 'approve' && !window.confirm(`Approve payout details for ${p.email ?? p.user_id}? Both ID images are deleted.`)) return;
    setBusy(p.user_id); setMessage(null);
    const r = await adminApi(`/api/v1/admin/referrals/payout-profiles/${encodeURIComponent(p.user_id)}/${decision}`, { method: 'POST', body: reason ? { reason } : {} });
    setBusy(null);
    if (!r.ok) { setMessage({ kind: 'error', text: `${p.email ?? p.user_id}: ${r.message}` }); return; }
    setViewer(null);
    setMessage({ kind: 'ok', text: `${p.email ?? p.user_id}: ${decision === 'approve' ? 'approved' : 'rejected'}; ID images deleted.` });
    void load();
  };

  return (
    <section aria-labelledby="ref-kyc" className={panel}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="ref-kyc" className="font-bold text-white text-sm">Payout details (KYC) · {items.length}</h3>
        <label className="flex items-center gap-2 text-xs text-stone-400">Status
          <select className={field} value={status} onChange={e => setStatus(STATUSES.find(x => x === e.target.value) ?? 'submitted')}>
            {STATUSES.map(x => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
      </div>
      <p className="text-[11px] text-stone-500">Opening an ID image is recorded in the audit log.</p>
      <Flash message={message} />
      {busy !== 'load' && items.length === 0 && <p className="text-xs text-stone-400">Nothing to review.</p>}
      <ul className="space-y-3">
        {items.map(p => {
          const working = busy === p.user_id;
          const reviewable = p.status === 'submitted';
          return (
            <li key={p.user_id} className={row} aria-busy={working}>
              <div className="flex flex-wrap items-center gap-2">
                <Pill status={p.status} />
                <span className="text-white font-semibold break-all">{p.email ?? p.user_id}</span>
                {p.name && <span className="text-stone-400">{p.name}</span>}
                <span className="text-stone-400">{p.method === 'paypal' ? 'PayPal' : 'VN bank'} · updated {when(p.updated_at || null)}</span>
              </div>
              {p.method === 'paypal' ? (
                <p>PayPal: <span className="text-white break-all">{p.paypal_email ?? '—'}</span></p>
              ) : (
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                  <div><dt className="inline text-stone-500">Full name: </dt><dd className="inline text-white">{p.full_name ?? '—'}</dd></div>
                  <div><dt className="inline text-stone-500">CCCD: </dt><dd className="inline font-mono">{p.national_id ?? '—'}</dd></div>
                  <div><dt className="inline text-stone-500">Bank: </dt><dd className="inline">{p.bank_name ?? '—'} · <span className="font-mono">{p.bank_account ?? '—'}</span></dd></div>
                  <div><dt className="inline text-stone-500">Address: </dt><dd className="inline break-words">{p.address ?? '—'}</dd></div>
                </dl>
              )}
              {p.reject_reason && <p className="text-rose-300">Rejected: {p.reject_reason}</p>}
              {p.method === 'vn_bank' && (
                <div className="flex flex-wrap gap-2">
                  {(['front', 'back'] as const).map(side => (
                    <button key={side} type="button" className={btn} disabled={!(side === 'front' ? p.has_id_front : p.has_id_back)} onClick={() => setViewer({ profile: p, side })}>
                      View {side}{(side === 'front' ? p.has_id_front : p.has_id_back) ? '' : ' (missing)'}
                    </button>
                  ))}
                </div>
              )}
              {reviewable && (
                <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                  <label htmlFor={`kyc-reason-${p.user_id}`} className="sr-only">Reject reason for {p.email}</label>
                  <input id={`kyc-reason-${p.user_id}`} className={`${field} flex-1`} maxLength={500} placeholder="Reason (required to reject; shown to the member)" value={reasons[p.user_id] ?? ''} disabled={working} onChange={e => setReasons({ ...reasons, [p.user_id]: e.target.value })} />
                  <div className="flex gap-2">
                    <button type="button" className={btnPrimary} disabled={working} onClick={() => void decide(p, 'approve')}>Approve</button>
                    <button type="button" className={btnDanger} disabled={working || !(reasons[p.user_id] ?? '').trim()} onClick={() => void decide(p, 'reject')}>Reject</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <dialog
        ref={dialogRef} aria-label="National ID image" onCancel={e => { e.preventDefault(); setViewer(null); }}
        className="w-[min(94vw,56rem)] rounded-2xl border border-stone-700 bg-stone-950 p-4 text-stone-100 backdrop:bg-black/80"
      >
        {viewer && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold">{viewer.profile.full_name ?? viewer.profile.email} · {viewer.side} · CCCD {viewer.profile.national_id ?? '—'}</p>
              <div className="flex gap-2">
                <button type="button" className={btn} onClick={() => setViewer({ ...viewer, side: viewer.side === 'front' ? 'back' : 'front' })}>Show {viewer.side === 'front' ? 'back' : 'front'}</button>
                <button type="button" className={btn} onClick={() => setViewer(null)} autoFocus>Close</button>
              </div>
            </div>
            <img
              key={`${viewer.profile.user_id}-${viewer.side}`} src={imageUrl(viewer.profile.user_id, viewer.side)} alt={`National ID ${viewer.side} of ${viewer.profile.full_name ?? 'member'}`}
              referrerPolicy="no-referrer" className="max-h-[70vh] w-full object-contain rounded-lg bg-stone-900"
            />
          </div>
        )}
      </dialog>
    </section>
  );
}
