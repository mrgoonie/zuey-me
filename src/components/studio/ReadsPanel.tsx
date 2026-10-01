import React, { useCallback, useEffect, useState } from 'react';
import type { ReadItem, ReadsSyncRun } from '../../lib/reads/store';

interface Envelope {
  success: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function readEnvelope(res: Response): Promise<Envelope> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { success: false, error: { message: `HTTP ${res.status}` } };
  }
  if (!isRecord(body)) return { success: false, error: { message: `HTTP ${res.status}` } };
  const err = isRecord(body.error) ? body.error : undefined;
  return {
    success: body.success === true && res.ok,
    data: body.data,
    error: err
      ? { code: typeof err.code === 'string' ? err.code : undefined, message: typeof err.message === 'string' ? err.message : undefined }
      : undefined,
  };
}

function isReadItem(v: unknown): v is ReadItem {
  return isRecord(v) && typeof v.id === 'string' && typeof v.url === 'string' && typeof v.visible === 'boolean';
}

function isSyncRun(v: unknown): v is ReadsSyncRun {
  return isRecord(v) && typeof v.id === 'string' && typeof v.status === 'string' && typeof v.started_at === 'string';
}

function fmt(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString('vi-VN', { timeZone: 'Asia/Saigon' });
}

/** Studio panel: last Zuey Reads sync run, manual sync trigger, and every read with its visibility flag. */
export const ReadsPanel: React.FC = () => {
  const [items, setItems] = useState<ReadItem[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<ReadsSyncRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/reads?include_hidden=1&limit=500', { credentials: 'same-origin' });
      const env = await readEnvelope(res);
      if (!env.success || !isRecord(env.data)) throw new Error(env.error?.message ?? 'Failed to load reads');
      const data = env.data;
      setItems(Array.isArray(data.items) ? data.items.filter(isReadItem) : []);
      setLastSyncedAt(typeof data.last_synced_at === 'string' ? data.last_synced_at : null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load reads');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const syncNow = async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/reads/sync', { method: 'POST', credentials: 'same-origin' });
      const env = await readEnvelope(res);
      if (!env.success || !isSyncRun(env.data)) {
        throw new Error(env.error ? `${env.error.code ?? 'error'}: ${env.error.message ?? ''}` : 'Sync failed');
      }
      setLastRun(env.data);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const visibleCount = items.filter(i => i.visible).length;

  return (
    <section className="bg-stone-950/80 border border-stone-800 rounded-3xl p-5 sm:p-6 text-stone-100">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-bold font-serif text-white">Zuey Reads</h2>
          <p className="text-xs text-stone-400 mt-1">
            AnyMD items tagged <code className="text-amber-300">zuey-reads</code> · {visibleCount} visible / {items.length} total · last synced {fmt(lastSyncedAt)}
          </p>
        </div>
        <button
          type="button"
          onClick={syncNow}
          disabled={syncing}
          className="px-4 py-2 rounded-xl bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-stone-950 text-sm font-semibold transition-colors"
        >
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      {lastRun && (
        <div className="mb-4 rounded-2xl border border-stone-800 bg-stone-900/70 p-3 text-xs text-stone-300">
          <div className="font-semibold text-white mb-1">
            Run {lastRun.status} · {fmt(lastRun.finished_at)}
          </div>
          <div>
            fetched {lastRun.fetched} · tagged {lastRun.tagged} · summarized {lastRun.summarized} · unchanged {lastRun.unchanged} · hidden {lastRun.hidden}
          </div>
          {lastRun.error && <pre className="mt-2 whitespace-pre-wrap break-words text-amber-300">{lastRun.error}</pre>}
        </div>
      )}

      {error && <div className="mb-4 rounded-xl border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-200">{error}</div>}

      {loading ? (
        <p className="text-sm text-stone-400">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-stone-400">No reads yet. Tag items with zuey-reads in AnyMD, then sync.</p>
      ) : (
        <ul className="divide-y divide-stone-800">
          {items.map(item => (
            <li key={item.id} className="py-3 flex items-start gap-3 min-w-0">
              <span
                className={`mt-0.5 shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                  item.visible ? 'bg-amber-400/20 text-amber-300' : 'bg-stone-800 text-stone-500'
                }`}
              >
                {item.visible ? 'visible' : 'hidden'}
              </span>
              <div className="min-w-0">
                <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-white hover:text-amber-300 break-words">
                  {item.title || item.url}
                </a>
                <div className="text-[11px] text-stone-500">
                  {[item.source_kind, item.site || item.domain, fmt(item.synced_at)].filter(Boolean).join(' · ')}
                </div>
                {item.summary && <p className="text-xs text-stone-400 mt-1 break-words">{item.summary}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
