import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SquarePlay } from 'lucide-react';
import type { RelatedArticle, VideoHit, VideoItem } from '../../lib/videos/types';
import { ZUEYTUBE_CHANNEL_URL, ZUEYTUBE_OPEN_EVENT, ZUEYTUBE_SUBSCRIBE_URL } from '../../lib/videos/types';
import { formatDuration } from '../../lib/videos/youtube-url';
import { apiFetch } from '../home/api-client';
import { parseVideoDetail, parseVideoHits } from './zueytube-api-client';
import { ZueytubePlayer } from './ZueytubePlayer';
import { formatVideoDate, zueytubeStrings } from './zueytube-strings';

interface ZueytubeBrowserProps {
  items: VideoItem[];
  locale: string;
  /** Standalone /videos page (true) or the Zuey OS window (false): only the page syncs ?v= on navigation. */
  standalone?: boolean;
  /** Video to open first (from ?v=). */
  initialRef?: string | null;
}

interface DetailState { status: 'loading' | 'ready' | 'error'; video: VideoItem | null; related: RelatedArticle[] | null }

const SEARCH_DEBOUNCE_MS = 260;

function preferredEdition(video: VideoItem, locale: string): string {
  const want = locale === 'vi' ? 'vi' : 'en';
  return (video.editions.find(e => e.locale === want) ?? video.editions[0]).youtube_id;
}

function findVideo(items: VideoItem[], ref: string): VideoItem | null {
  return items.find(v => v.id === ref || v.editions.some(e => e.youtube_id === ref)) ?? null;
}

function setQueryParam(v: string | null) {
  const url = new URL(window.location.href);
  if (v) url.searchParams.set('v', v); else url.searchParams.delete('v');
  window.history.replaceState(window.history.state, '', url);
}

/** Renders `**term**` snippet markers as <mark> without using HTML injection. */
function Snippet({ text }: { text: string }) {
  const parts = text.split('**');
  return <>{parts.map((p, i) => (i % 2 === 1 ? <mark key={i} className="bg-amber-200/70 text-stone-900 rounded px-0.5">{p}</mark> : <React.Fragment key={i}>{p}</React.Fragment>))}</>;
}

export const ZueytubeBrowser: React.FC<ZueytubeBrowserProps> = ({ items, locale, standalone = false, initialRef = null }) => {
  const t = zueytubeStrings(locale);
  const [selected, setSelected] = useState<{ video: VideoItem; edition: string } | null>(() => {
    const v = initialRef ? findVideo(items, initialRef) : null;
    return v ? { video: v, edition: v.editions.some(e => e.youtube_id === initialRef) && initialRef ? initialRef : preferredEdition(v, locale) } : null;
  });
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<VideoHit[] | null>(null);
  const topRef = useRef<HTMLDivElement>(null);

  const open = useCallback((ref: string) => {
    const v = findVideo(items, ref);
    if (!v) return;
    setSelected({ video: v, edition: v.editions.some(e => e.youtube_id === ref) ? ref : preferredEdition(v, locale) });
    topRef.current?.scrollIntoView({ block: 'start' });
  }, [items, locale]);

  // Deep links: ?v= on mount (homepage window) and the open event from other surfaces.
  useEffect(() => {
    if (!initialRef) {
      const v = new URLSearchParams(window.location.search).get('v');
      if (v) open(v);
    }
    const onOpen = (e: Event) => {
      if (e instanceof CustomEvent && typeof e.detail === 'string') open(e.detail);
    };
    window.addEventListener(ZUEYTUBE_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(ZUEYTUBE_OPEN_EVENT, onOpen);
  }, [open, initialRef]);

  useEffect(() => {
    if (standalone) setQueryParam(selected ? selected.edition : null);
  }, [selected, standalone]);

  const selectedId = selected?.video.id ?? null;
  useEffect(() => {
    if (!selectedId || details[selectedId]) return;
    setDetails(d => ({ ...d, [selectedId]: { status: 'loading', video: null, related: null } }));
    void apiFetch(`/api/v1/videos/${encodeURIComponent(selectedId)}`, parseVideoDetail).then(res => {
      setDetails(d => ({
        ...d,
        [selectedId]: res.ok ? { status: 'ready', video: res.data.video, related: res.data.related_articles } : { status: 'error', video: null, related: null },
      }));
    });
  }, [selectedId, details]);

  // Transcript-aware server search (title-only filtering happens locally below).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits(null); return; }
    const timer = setTimeout(() => {
      void apiFetch(`/api/v1/videos?q=${encodeURIComponent(q)}&locale=${encodeURIComponent(locale)}&limit=8`, parseVideoHits).then(res => {
        setHits(res.ok ? res.data : []);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, locale]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(v => v.editions.some(e => [e.title, e.description].some(s => s.toLowerCase().includes(q))));
  }, [items, query]);
  const transcriptOnly = (hits ?? []).filter(h => !filtered.some(v => v.id === h.video_id));

  const detail = selectedId ? details[selectedId] : undefined;

  return (
    <main className="relative min-h-screen w-full flex flex-col items-center justify-start py-3 sm:py-8 md:py-12 px-2.5 sm:px-4 md:px-6 z-10">
      <div ref={topRef} className="w-full max-w-[760px] bg-[#F5EFEB] rounded-[28px] sm:rounded-[36px] md:rounded-[40px] border border-stone-200/90 shadow-floating-card px-3.5 py-6 sm:px-6 sm:py-8 md:p-8 flex flex-col min-w-0">
        <header className="mb-5 sm:mb-6 flex flex-col gap-3">
          {standalone && <a href="/" className="text-xs font-semibold text-stone-500 hover:text-stone-900">← zuey.me</a>}
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <h1 className="font-serif text-3xl sm:text-4xl font-black tracking-tight text-stone-900 flex items-center gap-2">
                <SquarePlay className="text-red-600 shrink-0" size={32} aria-hidden="true" /> {t.title}
              </h1>
              <p className="text-sm text-stone-600 mt-1.5">{t.subtitle}</p>
            </div>
            <div className="flex items-center gap-2">
              <a href={ZUEYTUBE_SUBSCRIBE_URL} target="_blank" rel="noopener noreferrer" className="px-3.5 py-2 rounded-full bg-red-600 text-white text-xs font-bold hover:bg-red-700">
                {t.subscribe}
              </a>
              <a href={ZUEYTUBE_CHANNEL_URL} target="_blank" rel="noopener noreferrer" className="px-3.5 py-2 rounded-full bg-white/80 border border-stone-300/80 text-stone-800 text-xs font-bold hover:bg-white">
                {t.channel}
              </a>
            </div>
          </div>
        </header>

        {selected ? (
          <div className="flex flex-col gap-4">
            <button type="button" onClick={() => setSelected(null)} className="self-start text-xs font-semibold text-stone-500 hover:text-stone-900">{t.back}</button>
            <ZueytubePlayer
              video={detail?.video ?? selected.video}
              related={detail?.related ?? null}
              editionId={selected.edition}
              onEdition={id => setSelected(s => (s ? { ...s, edition: id } : s))}
              loading={!detail || detail.status === 'loading'}
              failed={detail?.status === 'error'}
              strings={t}
              locale={locale}
            />
          </div>
        ) : (
          <>
            <label className="sr-only" htmlFor="zueytube-search">{t.searchLabel}</label>
            <input
              id="zueytube-search"
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t.search}
              className="w-full min-w-0 mb-5 rounded-2xl border border-stone-300/80 bg-white/90 px-4 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-red-300"
            />
            {filtered.length === 0 && transcriptOnly.length === 0 ? (
              <div className="text-center py-10 text-sm text-stone-500">{items.length === 0 ? t.empty : t.noMatch}</div>
            ) : (
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {filtered.map(v => {
                  const e = v.editions.find(x => x.youtube_id === preferredEdition(v, locale)) ?? v.editions[0];
                  return (
                    <li key={v.id} className="min-w-0">
                      <button type="button" onClick={() => open(e.youtube_id)} className="group w-full text-left bg-white/80 border border-stone-200/90 rounded-2xl overflow-hidden hover:shadow-md transition-shadow">
                        <div className="relative w-full bg-stone-900" style={{ aspectRatio: '16 / 9' }}>
                          {e.thumbnail_url && <img src={e.thumbnail_url} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover group-hover:opacity-90" />}
                          {e.duration_seconds !== null && (
                            <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/80 px-1.5 py-0.5 text-[11px] font-semibold text-white tabular-nums">{formatDuration(e.duration_seconds)}</span>
                          )}
                        </div>
                        <div className="p-3">
                          <p className="font-serif font-bold leading-snug text-stone-900 line-clamp-2 break-words">{e.title}</p>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-stone-500">
                            {v.editions.map(x => <span key={x.youtube_id} className="px-1.5 py-0.5 rounded-md bg-stone-900 text-[#F5EFEB] font-bold">{x.locale.toUpperCase()}</span>)}
                            {e.published_at && <span>{formatVideoDate(e.published_at, locale)}</span>}
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {transcriptOnly.length > 0 && (
              <section className="mt-5" aria-label={t.transcriptMatches}>
                <h2 className="text-xs font-bold uppercase tracking-wide text-stone-500 mb-2">{t.transcriptMatches}</h2>
                <ul className="flex flex-col gap-2">
                  {transcriptOnly.map(h => (
                    <li key={h.video_id}>
                      <button type="button" onClick={() => open(h.youtube_id)} className="w-full text-left bg-white/80 border border-stone-200/90 rounded-2xl p-3 hover:bg-white">
                        <p className="font-serif font-bold text-stone-900 break-words">{h.title}</p>
                        {h.snippet && <p className="text-xs text-stone-600 mt-1 break-words"><Snippet text={h.snippet} /></p>}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        <footer className="mt-6 flex flex-wrap items-center justify-between gap-2 text-[11px] text-stone-500">
          <span>youtube.com/@imzuey</span>
          <a href="/videos.md" className="font-semibold hover:text-stone-900">videos.md</a>
        </footer>
      </div>
    </main>
  );
};
