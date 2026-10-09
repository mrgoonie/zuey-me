import React, { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, RefreshCw, Star, Trash2 } from 'lucide-react';
import type { VideoEdition, VideoItem, VideoLocale } from '../../lib/videos/types';
import { formatDuration } from '../../lib/videos/youtube-url';
import { parseVideoList } from '../zueytube/zueytube-api-client';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Calls the admin API and returns `data`, or throws with the API's error code/message. */
async function call(url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  if (res.ok && isRecord(body) && body.success === true) return body.data;
  const err = isRecord(body) && isRecord(body.error) ? body.error : {};
  throw new Error(`${typeof err.code === 'string' ? err.code : `HTTP ${res.status}`}: ${typeof err.message === 'string' ? err.message : res.statusText}`);
}

const STATUS_STYLE: Record<VideoEdition['transcript_status'], string> = {
  ready: 'bg-emerald-400/15 text-emerald-300',
  pending: 'bg-stone-800 text-stone-400',
  unavailable: 'bg-amber-400/15 text-amber-300',
  failed: 'bg-red-500/15 text-red-300',
};

const input = 'rounded-xl bg-stone-900 border border-stone-700 px-3 py-2 text-sm text-white placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-red-400/60 min-w-0';
const iconBtn = 'p-1.5 rounded-lg text-stone-400 hover:text-white hover:bg-stone-800 disabled:opacity-40';

/** Studio panel: add YouTube links (optionally as the other-language edition), see transcript status, refetch, order and remove. */
export const VideosPanel: React.FC = () => {
  const [items, setItems] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [locale, setLocale] = useState<VideoLocale>('vi');
  const [pairWith, setPairWith] = useState('');
  const [title, setTitle] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = parseVideoList(await call('/api/v1/videos?limit=200'));
      if (!data) throw new Error('Unexpected response');
      setItems(data.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load videos');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, fn: () => Promise<string | null>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  };

  const transcriptNote = (data: unknown): string => {
    if (!isRecord(data)) return 'Added.';
    const status = typeof data.transcript_status === 'string' ? data.transcript_status : 'unknown';
    const err = typeof data.transcript_error === 'string' ? ` (${data.transcript_error})` : '';
    return `Transcript: ${status}${err}`;
  };

  const add = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!url.trim()) return;
    void run('add', async () => {
      const data = await call('/api/v1/videos', {
        method: 'POST',
        body: JSON.stringify({ url: url.trim(), locale, pair_with: pairWith || undefined, title: title.trim() || undefined }),
      });
      setUrl('');
      setTitle('');
      setPairWith('');
      return transcriptNote(data);
    });
  };

  const patch = (id: string, body: Record<string, unknown>) =>
    run(`patch:${id}`, async () => { await call(`/api/v1/videos/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }); return null; });

  const remove = (id: string, label: string) => {
    if (!window.confirm(`Remove ${label} from Zueytube?`)) return;
    void run(`delete:${id}`, async () => { await call(`/api/v1/videos/${encodeURIComponent(id)}`, { method: 'DELETE' }); return 'Removed.'; });
  };

  const refetch = (youtubeId: string) =>
    run(`refetch:${youtubeId}`, async () => transcriptNote(await call(`/api/v1/videos/${encodeURIComponent(youtubeId)}/refetch`, { method: 'POST' })));

  // Swapping positions with the neighbour keeps the curated order explicit and stable.
  const move = (index: number, dir: -1 | 1) => {
    const a = items[index];
    const b = items[index + dir];
    if (!a || !b) return;
    void run(`move:${a.id}`, async () => {
      const pa = a.position === b.position ? b.position - dir : b.position;
      await call(`/api/v1/videos/${encodeURIComponent(a.id)}`, { method: 'PATCH', body: JSON.stringify({ position: pa }) });
      await call(`/api/v1/videos/${encodeURIComponent(b.id)}`, { method: 'PATCH', body: JSON.stringify({ position: a.position }) });
      return null;
    });
  };

  const label = (v: VideoItem) => v.editions[0]?.title ?? v.id;

  return (
    <section className="bg-stone-950/80 border border-stone-800 rounded-3xl p-5 sm:p-6 text-stone-100">
      <div className="mb-4">
        <h2 className="text-lg font-bold font-serif text-white">Zueytube</h2>
        <p className="text-xs text-stone-400 mt-1">
          Paste a YouTube link from @imzuey. The transcript is fetched once via AnyMD (3 credits); videos without captions are still added. {items.length} videos.
        </p>
      </div>

      <form onSubmit={add} className="mb-5 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
        <input className={input} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" aria-label="YouTube link" required />
        <div className="flex gap-2">
          <select className={input} value={locale} onChange={e => setLocale(e.target.value === 'en' ? 'en' : 'vi')} aria-label="Language">
            <option value="vi">VI</option>
            <option value="en">EN</option>
          </select>
          <button type="submit" disabled={busy !== null} className="px-4 py-2 rounded-xl bg-red-500 hover:bg-red-400 disabled:opacity-50 text-white text-sm font-semibold">
            {busy === 'add' ? 'Adding…' : 'Add video'}
          </button>
        </div>
        <select className={input} value={pairWith} onChange={e => setPairWith(e.target.value)} aria-label="Pair with existing video">
          <option value="">New video (no pairing)</option>
          {items.map(v => <option key={v.id} value={v.id}>Pair with: {label(v)} ({v.editions.map(e => e.locale.toUpperCase()).join('/')})</option>)}
        </select>
        <input className={input} value={title} onChange={e => setTitle(e.target.value)} placeholder="Title override (optional)" aria-label="Title override" />
      </form>

      {notice && <div className="mb-4 rounded-xl border border-stone-700 bg-stone-900 px-3 py-2 text-xs text-stone-200">{notice}</div>}
      {error && <div className="mb-4 rounded-xl border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-200">{error}</div>}

      {loading ? (
        <p className="text-sm text-stone-400">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-stone-400">No videos yet.</p>
      ) : (
        <ul className="divide-y divide-stone-800">
          {items.map((v, i) => (
            <li key={v.id} className="py-3 flex flex-col gap-2 min-w-0">
              <div className="flex items-center gap-1">
                <button type="button" className={iconBtn} onClick={() => move(i, -1)} disabled={i === 0 || busy !== null} aria-label="Move up"><ArrowUp size={14} /></button>
                <button type="button" className={iconBtn} onClick={() => move(i, 1)} disabled={i === items.length - 1 || busy !== null} aria-label="Move down"><ArrowDown size={14} /></button>
                <button type="button" className={`${iconBtn} ${v.featured ? 'text-amber-300' : ''}`} onClick={() => void patch(v.id, { featured: !v.featured })} disabled={busy !== null} aria-label={v.featured ? 'Unfeature' : 'Feature'} aria-pressed={v.featured}>
                  <Star size={14} />
                </button>
                <span className="text-[11px] text-stone-500 font-mono">{v.id}</span>
                <button type="button" className={`${iconBtn} ml-auto`} onClick={() => remove(v.id, `"${label(v)}" (all editions)`)} disabled={busy !== null} aria-label="Delete video"><Trash2 size={14} /></button>
              </div>
              {v.editions.map(e => (
                <div key={e.youtube_id} className="flex items-start gap-3 pl-2 min-w-0">
                  <span className="mt-0.5 shrink-0 px-2 py-0.5 rounded-full bg-stone-800 text-[10px] font-bold text-white">{e.locale.toUpperCase()}</span>
                  <div className="min-w-0 flex-1">
                    <a href={e.watch_url} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-white hover:text-red-300 break-words">{e.title}</a>
                    <div className="text-[11px] text-stone-500 flex flex-wrap gap-x-2 items-center">
                      <span className={`px-1.5 py-0.5 rounded-md font-semibold ${STATUS_STYLE[e.transcript_status]}`}>transcript {e.transcript_status}</span>
                      {e.word_count > 0 && <span>{e.word_count} words</span>}
                      {e.duration_seconds !== null && <span>{formatDuration(e.duration_seconds)}</span>}
                      {e.transcript_error && <span className="text-stone-400">{e.transcript_error}</span>}
                    </div>
                  </div>
                  <button type="button" className={iconBtn} onClick={() => void refetch(e.youtube_id)} disabled={busy !== null} aria-label="Refetch transcript" title="Refetch transcript">
                    <RefreshCw size={14} className={busy === `refetch:${e.youtube_id}` ? 'animate-spin' : ''} />
                  </button>
                  {v.editions.length > 1 && (
                    <button type="button" className={iconBtn} onClick={() => remove(e.youtube_id, `the ${e.locale.toUpperCase()} edition`)} disabled={busy !== null} aria-label="Delete edition"><Trash2 size={14} /></button>
                  )}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
