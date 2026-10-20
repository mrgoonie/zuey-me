import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { PresenceDiagnostics } from '../../lib/presence/contract';
import { parsePresenceDiagnostics } from '../../lib/presence/presence-diagnostics-guards';

const ENDPOINT = '/api/v1/presence/diagnostics';
/** Auto refresh while the tab is open and the page visible; never faster than 15 s. */
export const DIAGNOSTICS_REFRESH_MS = 30_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A failed diagnostics request; `status` lets the panel tell an expired session (401/403) from an outage. */
class DiagnosticsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const isAuthFailure = (e: unknown): boolean => e instanceof DiagnosticsError && (e.status === 401 || e.status === 403);

/** Reads the `{ success, data | error }` envelope into diagnostics or a readable error. */
async function readDiagnostics(res: Response): Promise<PresenceDiagnostics> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const data = res.ok && isRecord(body) && body.success === true ? parsePresenceDiagnostics(body.data) : null;
  if (data) return data;
  const err = isRecord(body) && isRecord(body.error) ? body.error : null;
  const code = err && typeof err.code === 'string' ? err.code : `HTTP ${res.status}`;
  const message = err && typeof err.message === 'string' ? err.message : 'Unexpected response';
  throw new DiagnosticsError(`${code}: ${message}`, res.status);
}

const fmtTime = (ts: string | null): string => {
  if (ts === null) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString('vi-VN', { timeZone: 'Asia/Saigon' });
};
const fmtNum = (n: number): string => n.toLocaleString('en-US');
const fmtBytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);

const Group: React.FC<{ title: string; rows: Array<[string, string]> }> = ({ title, rows }) => (
  <div className="rounded-2xl border border-stone-800 bg-stone-900/70 p-4" data-diagnostics-group={title}>
    <h3 className="text-[11px] uppercase tracking-wide text-stone-500 mb-2">{title}</h3>
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-xs">
      {rows.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-stone-400">{k}</dt>
          <dd className="text-white font-semibold tabular-nums text-right">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  </div>
);

/** Studio panel (all admins): read-only presence Worker diagnostics with manual and slow auto refresh. */
export const PresenceDiagnosticsPanel: React.FC = () => {
  const [data, setData] = useState<PresenceDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  /** Set after a 401/403: auto refresh stops (each call would only fail again); a manual Refresh still retries. */
  const [authStopped, setAuthStopped] = useState(false);
  const authStoppedRef = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      setData(await readDiagnostics(await fetch(ENDPOINT, { credentials: 'same-origin', headers: { Accept: 'application/json' } })));
      setError(null);
      authStoppedRef.current = false;
      setAuthStopped(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load presence diagnostics');
      if (isAuthFailure(e)) {
        authStoppedRef.current = true;
        setAuthStopped(true);
      }
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible' && !authStoppedRef.current) void load();
    }, DIAGNOSTICS_REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <section className="bg-stone-950/80 border border-stone-800 rounded-3xl p-5 sm:p-6 text-stone-100 space-y-4" data-presence-diagnostics>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold font-serif text-white">Presence diagnostics</h2>
          <p className="text-xs text-stone-400 mt-1">
            Live counters of the presence Worker. Counts only, no visitor data.{' '}
            {authStopped ? 'Auto refresh is paused until you sign in again and press Refresh.' : `Refreshes every ${DIAGNOSTICS_REFRESH_MS / 1000}s while open.`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="px-3 py-1.5 rounded-xl bg-stone-800 hover:bg-stone-700 disabled:opacity-50 text-stone-200 text-xs font-semibold border border-stone-700"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <p role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-300">{error}</p>}

      {data && (
        <>
          <p className="text-[11px] text-stone-500">As of {fmtTime(data.at)}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Group title="Sockets" rows={[
              ['Total open', fmtNum(data.sockets.total)],
              ['Active sessions (counted)', fmtNum(data.sockets.activeSessions)],
              ['Idle / hidden', fmtNum(data.sockets.idle)],
              ['Watch-only', fmtNum(data.sockets.watchOnly)],
              ['Subscribers', fmtNum(data.sockets.subscribers)],
              ['Owner', fmtNum(data.sockets.owner)],
            ]} />
            <Group title="Limits" rows={[
              ['Max sockets', fmtNum(data.limits.maxTotal)],
              ['Max per IP', fmtNum(data.limits.maxPerIp)],
              ['Max per key', fmtNum(data.limits.maxPerKey)],
            ]} />
            <Group title="Counters (since last wake)" rows={[
              ['Woke at', fmtTime(data.counters.startedAt)],
              ['Connects accepted', fmtNum(data.counters.connectsAccepted)],
              ['Connects rejected', fmtNum(data.counters.connectsRejected)],
              ['Messages dropped', fmtNum(data.counters.messagesDropped)],
              ['Abuse closes', fmtNum(data.counters.abuseCloses)],
              ['Broadcasts', fmtNum(data.counters.broadcasts)],
            ]} />
            <Group title="Alarm & history" rows={[
              ['Next alarm', fmtTime(data.alarm.nextAt)],
              ['Last run', fmtTime(data.alarm.lastRunAt)],
              ['Last run took', data.alarm.lastRunMs === null ? '—' : `${fmtNum(Math.round(data.alarm.lastRunMs))} ms`],
              ['History buckets', fmtNum(data.history.buckets)],
              ['Oldest bucket', fmtTime(data.history.oldest)],
              ['History storage', fmtBytes(data.history.storageBytes)],
            ]} />
          </div>
          <p className="text-[11px] text-stone-500">
            Counters and alarm timings are kept in memory. The hub hibernates after about 10 s without events, which
            resets them, so they show only activity since the last wake (a request like this one wakes it).
          </p>
        </>
      )}
    </section>
  );
};
