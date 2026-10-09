import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { AccountFlag, AccountFlagStatus } from '../../../lib/members/account-flags';
import { StatusLine, api, btnCls, dangerCls, formatTime, inputCls, isObj, objArr, primaryCls, str, strOrNull, tabCls } from '../knowledge-studio-kit';
import type { ApiResult, StatusMsg } from '../knowledge-studio-kit';
import { errText } from './courses-admin-api';

type Filter = AccountFlagStatus | 'all';
const FILTERS: Filter[] = ['open', 'dismissed', 'locked', 'all'];
interface Lock { user_id: string; email: string | null; reason: string; locked_at: string }

function toFlag(o: Record<string, unknown>): AccountFlag {
  const s = str(o, 'status');
  return {
    id: str(o, 'id'), user_id: str(o, 'user_id'), email: strOrNull(o, 'email'), kind: str(o, 'kind'),
    detail: isObj(o.detail) ? o.detail : {}, status: s === 'dismissed' || s === 'locked' ? s : 'open',
    created_at: str(o, 'created_at'), resolved_at: strOrNull(o, 'resolved_at'),
  };
}

/** Anti-abuse queue (sharing/session signals) plus the list of course-access locks. */
export function CourseAbuseReview() {
  const [filter, setFilter] = useState<Filter>('open');
  const [flags, setFlags] = useState<AccountFlag[] | null>(null);
  const [locks, setLocks] = useState<Lock[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMsg | null>(null);
  const [lockUser, setLockUser] = useState('');
  const [lockReason, setLockReason] = useState('');

  const load = useCallback(async () => {
    const r = await api(`/api/v1/admin/account-flags?status=${filter}`);
    if (!r.ok || !isObj(r.data)) { setStatus({ text: errText(r), error: true }); setFlags([]); return; }
    setFlags(objArr(r.data.flags).map(toFlag));
    setLocks(objArr(r.data.locks).map(l => ({ user_id: str(l, 'user_id'), email: strOrNull(l, 'email'), reason: str(l, 'reason'), locked_at: str(l, 'locked_at') })));
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<ApiResult>, done: string): Promise<boolean> => {
    setBusy(true);
    setStatus(null);
    const r = await fn();
    setStatus(r.ok ? { text: done, error: false } : { text: errText(r), error: true });
    if (r.ok) await load();
    setBusy(false);
    return r.ok;
  };

  const resolve = (f: AccountFlag, action: 'dismiss' | 'lock') => {
    const who = f.email ?? f.user_id;
    if (action === 'lock' && !window.confirm(`Lock course access for ${who}? They are signed out everywhere and cannot open paid lessons until unlocked.`)) return;
    void run(() => api(`/api/v1/admin/account-flags/${encodeURIComponent(f.id)}`, { method: 'POST', body: { action } }), action === 'lock' ? `${who} locked.` : 'Flag dismissed.');
  };

  const unlock = (l: Lock) => {
    if (!window.confirm(`Unlock course access for ${l.email ?? l.user_id}?`)) return;
    void run(() => api('/api/v1/admin/course-locks', { method: 'DELETE', body: { user_id: l.user_id } }), 'Unlocked.');
  };

  const lockManually = async (e: FormEvent) => {
    e.preventDefault();
    if (!window.confirm(`Lock course access for user ${lockUser.trim()}?`)) return;
    if (await run(() => api('/api/v1/admin/course-locks', { method: 'POST', body: { user_id: lockUser.trim(), reason: lockReason.trim() || undefined } }), 'Locked.')) {
      setLockUser(''); setLockReason('');
    }
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Flag status">
          {FILTERS.map(f => <button key={f} type="button" role="tab" aria-selected={filter === f} className={tabCls(filter === f)} onClick={() => setFilter(f)}>{f}</button>)}
          <StatusLine status={status} />
        </div>
        {flags === null ? <p className="text-xs text-stone-400">Loading…</p> : flags.length === 0 ? <p className="text-xs text-stone-500">No flags.</p> : (
          <ul className="space-y-2">
            {flags.map(f => (
              <li key={f.id} className="rounded-xl border border-stone-800 bg-stone-950/60 p-3 space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-white font-semibold">{f.email ?? f.user_id}</span>
                  <span className="px-1.5 py-0.5 rounded-md text-[10px] bg-amber-400/15 text-amber-300">{f.kind}</span>
                  <span className="px-1.5 py-0.5 rounded-md text-[10px] bg-stone-800 text-stone-300">{f.status}</span>
                  <span className="ml-auto text-stone-500">{formatTime(f.created_at)}</span>
                </div>
                <pre className="text-[10px] text-stone-400 font-mono whitespace-pre-wrap break-all">{JSON.stringify(f.detail)}</pre>
                {f.status === 'open' && (
                  <div className="flex gap-1.5">
                    <button type="button" className={btnCls} disabled={busy} onClick={() => resolve(f, 'dismiss')}>Dismiss</button>
                    <button type="button" className={dangerCls} disabled={busy} onClick={() => resolve(f, 'lock')}>Lock account</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="text-xs font-bold text-white">Locked accounts ({locks.length})</h4>
        {locks.length === 0 ? <p className="text-xs text-stone-500">Nobody is locked.</p> : (
          <ul className="divide-y divide-stone-800">
            {locks.map(l => (
              <li key={l.user_id} className="py-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-white flex-1 min-w-0 truncate">{l.email ?? l.user_id}</span>
                <span className="text-stone-400">{l.reason}</span>
                <span className="text-stone-500">{formatTime(l.locked_at)}</span>
                <button type="button" className={btnCls} disabled={busy} onClick={() => unlock(l)}>Unlock</button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={e => void lockManually(e)} className="flex flex-wrap items-center gap-2">
          <input className={`${inputCls} flex-1`} value={lockUser} onChange={e => setLockUser(e.target.value)} placeholder="User id (usr_…)" aria-label="User id to lock" required />
          <input className={`${inputCls} flex-1`} value={lockReason} onChange={e => setLockReason(e.target.value)} placeholder="Reason" aria-label="Lock reason" />
          <button type="submit" className={primaryCls} disabled={busy || !lockUser.trim()}>Lock manually</button>
        </form>
      </div>
    </div>
  );
}
