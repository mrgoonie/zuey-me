import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { CourseOwnerRow } from '../../../lib/courses/course-purchases';
import { StatusLine, api, dangerCls, formatTime, inputCls, isObj, objArr, primaryCls, str, strOrNull } from '../knowledge-studio-kit';
import type { StatusMsg } from '../knowledge-studio-kit';
import { coursePath, errText } from './courses-admin-api';

function OwnerRow({ owner, busy, onRevoke }: { owner: CourseOwnerRow; busy: boolean; onRevoke: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const active = owner.status === 'active';
  return (
    <li className="py-2 flex flex-wrap items-center gap-2 min-w-0">
      <span className="text-xs text-white flex-1 min-w-0 truncate">{owner.email ?? owner.user_id}</span>
      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-stone-800 text-stone-300">{owner.source}</span>
      <span className={`text-[10px] px-1.5 py-0.5 rounded-md ${active ? 'bg-emerald-400/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}>{owner.status}</span>
      <span className="text-[11px] text-stone-500">{formatTime(owner.granted_at)}</span>
      {active ? (
        <>
          <input className={`${inputCls} w-48`} value={reason} onChange={e => setReason(e.target.value)} placeholder="Revoke reason" aria-label={`Revoke reason for ${owner.email ?? owner.user_id}`} />
          <button type="button" className={dangerCls} disabled={busy || !reason.trim()} onClick={() => onRevoke(reason.trim())}>Revoke</button>
        </>
      ) : owner.revoked_reason && <span className="text-[11px] text-stone-500">({owner.revoked_reason})</span>}
    </li>
  );
}

/** Who owns the course: complimentary grants by email and revocation with a reason. */
export function CourseOwnersManager({ courseId, onChanged }: { courseId: string; onChanged: () => Promise<void> }) {
  const [owners, setOwners] = useState<CourseOwnerRow[] | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMsg | null>(null);
  const url = `${coursePath(courseId)}/owners`;

  const load = useCallback(async () => {
    const r = await api(url);
    if (!r.ok) { setStatus({ text: errText(r), error: true }); setOwners([]); return; }
    setOwners(objArr(r.data).map(o => ({
      user_id: str(o, 'user_id'), email: strOrNull(o, 'email'), source: str(o, 'source'), status: str(o, 'status'),
      granted_at: str(o, 'granted_at'), revoked_reason: strOrNull(o, 'revoked_reason'),
    })));
  }, [url]);

  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => ReturnType<typeof api>, done: (data: unknown) => string) => {
    setBusy(true);
    setStatus(null);
    const r = await fn();
    setStatus(r.ok ? { text: done(r.data), error: false } : { text: errText(r), error: true });
    if (r.ok) { await load(); await onChanged(); }
    setBusy(false);
    return r.ok;
  };

  const grant = async (e: FormEvent) => {
    e.preventDefault();
    if (await act(() => api(url, { method: 'POST', body: { email: email.trim() } }), d => (isObj(d) && d.granted === false ? 'Already an owner.' : 'Access granted.'))) setEmail('');
  };

  const revoke = (o: CourseOwnerRow, reason: string) => {
    if (!window.confirm(`Revoke ${o.email ?? o.user_id}'s access to this course? GitHub access and the certificate are removed too.`)) return;
    void act(() => api(url, { method: 'DELETE', body: { user_id: o.user_id, reason } }), d => (isObj(d) && d.revoked === false ? 'Nothing to revoke.' : 'Access revoked.'));
  };

  return (
    <div className="space-y-3">
      <form onSubmit={e => void grant(e)} className="flex flex-wrap items-center gap-2">
        <input className={`${inputCls} flex-1`} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="member@email.com" aria-label="Member email to grant" required />
        <button type="submit" className={primaryCls} disabled={busy}>Grant access</button>
      </form>
      <StatusLine status={status} />
      {owners === null ? <p className="text-xs text-stone-400">Loading…</p> : owners.length === 0 ? <p className="text-xs text-stone-500">No owners yet.</p> : (
        <ul className="divide-y divide-stone-800">
          {owners.map(o => <OwnerRow key={`${o.user_id}:${o.status}`} owner={o} busy={busy} onRevoke={reason => revoke(o, reason)} />)}
        </ul>
      )}
    </div>
  );
}
