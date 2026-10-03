import React, { useMemo, useState } from 'react';
import type { ReadItem, ReadsSourceFacet } from '../../lib/reads/store';

interface ReadsBrowserProps {
  items: ReadItem[];
  sources: ReadsSourceFacet[];
  lastSyncedAt: string | null;
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('vi-VN', { timeZone: 'Asia/Saigon', year: 'numeric', month: '2-digit', day: '2-digit' });
}

function itemDate(item: ReadItem): string | null {
  if (item.published) return formatDate(item.published);
  return item.anymd_updated_at ? formatDate(new Date(item.anymd_updated_at * 1000).toISOString()) : null;
}

export const ReadsBrowser: React.FC<ReadsBrowserProps> = ({ items, sources, lastSyncedAt }) => {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(item => {
      if (source && item.source_kind !== source) return false;
      if (!q) return true;
      return [item.title, item.summary, item.site, item.domain].some(v => v && v.toLowerCase().includes(q));
    });
  }, [items, query, source]);

  const chip = (active: boolean) =>
    `px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
      active ? 'bg-stone-900 text-[#F5EFEB] border-stone-900' : 'bg-white/80 text-stone-700 border-stone-300/80 hover:bg-white'
    }`;

  return (
    <main className="relative min-h-screen w-full flex flex-col items-center justify-start py-3 sm:py-8 md:py-12 px-2.5 sm:px-4 md:px-6 z-10">
      <div className="w-full max-w-[680px] bg-[#F5EFEB] rounded-[28px] sm:rounded-[36px] md:rounded-[40px] border border-stone-200/90 shadow-floating-card px-3.5 py-6 sm:px-6 sm:py-8 md:p-8 flex flex-col min-w-0">
        <header className="mb-5 sm:mb-6">
          <a href="/" className="text-xs font-semibold text-stone-500 hover:text-stone-900">← zuey.me</a>
          <h1 className="font-serif text-3xl sm:text-4xl font-black tracking-tight text-stone-900 mt-2">Zuey Reads</h1>
          <p className="text-sm text-stone-600 mt-1.5">
            Những bài Zuey đã đọc &amp; recommend, kèm tóm tắt ngắn. Articles and videos worth your time.
          </p>
          <p className="text-[11px] text-stone-500 mt-2 bg-amber-100/70 border border-amber-200 rounded-xl px-3 py-2">
            Tóm tắt do AI tạo tự động và có thể sai; luôn có link về bài gốc. · AI-generated summaries may be inaccurate.
          </p>
        </header>

        <div className="flex flex-col gap-3 mb-5">
          <label className="sr-only" htmlFor="reads-search">Search reads</label>
          <input
            id="reads-search"
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Tìm bài… / Search…"
            className="w-full min-w-0 rounded-2xl border border-stone-300/80 bg-white/90 px-4 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-300"
          />
          {sources.length > 0 && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by source">
              <button type="button" className={chip(source === null)} onClick={() => setSource(null)} aria-pressed={source === null}>
                All
              </button>
              {sources.map(s => (
                <button
                  key={s.source_kind}
                  type="button"
                  className={chip(source === s.source_kind)}
                  onClick={() => setSource(source === s.source_kind ? null : s.source_kind)}
                  aria-pressed={source === s.source_kind}
                >
                  {s.source_kind} <span className="opacity-60">{s.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {filtered.length === 0 ? (
          <div className="text-center py-10 text-sm text-stone-500">
            {items.length === 0 ? 'Chưa có bài nào. No reads yet — check back soon.' : 'Không tìm thấy bài phù hợp. No matching reads.'}
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {filtered.map(item => {
              const date = itemDate(item);
              return (
                <li key={item.id} className="bg-white/80 border border-stone-200/90 rounded-2xl p-4 min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-stone-500 mb-1.5">
                    {item.source_kind && (
                      <span className="px-2 py-0.5 rounded-full bg-stone-900 text-[#F5EFEB] font-semibold uppercase tracking-wide">
                        {item.source_kind}
                      </span>
                    )}
                    <span className="break-all">{item.site || item.domain}</span>
                    {date && <span>· {date}</span>}
                  </div>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block font-serif text-lg font-bold leading-snug text-stone-900 hover:text-amber-700 break-words"
                  >
                    {item.title || item.url}
                  </a>
                  {item.summary && <p className="text-sm text-stone-700 mt-1.5 leading-relaxed break-words">{item.summary}</p>}
                </li>
              );
            })}
          </ul>
        )}

        <footer className="mt-6 flex flex-wrap items-center justify-between gap-2 text-[11px] text-stone-500">
          <span>{lastSyncedAt ? `Cập nhật / Synced: ${formatDate(lastSyncedAt)}` : 'Chưa đồng bộ / Not synced yet'}</span>
          <a href="/reads.md" className="font-semibold hover:text-stone-900">reads.md</a>
        </footer>
      </div>
    </main>
  );
};
