import React, { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Lock } from 'lucide-react';
import type { RelatedArticle, VideoEdition, VideoItem } from '../../lib/videos/types';
import { transcriptSegments } from '../../lib/videos/anymd-transcript-parser';
import { embedUrl, formatDuration } from '../../lib/videos/youtube-url';
import { formatVideoDate, type ZueytubeStrings } from './zueytube-strings';

interface ZueytubePlayerProps {
  video: VideoItem;
  /** Detail payload (transcripts + related); null while loading or when it failed. */
  related: RelatedArticle[] | null;
  editionId: string;
  onEdition: (youtubeId: string) => void;
  loading: boolean;
  failed: boolean;
  strings: ZueytubeStrings;
  locale: string;
}

const pill = (active: boolean) =>
  `px-3 py-1 rounded-full text-xs font-bold border transition-colors ${
    active ? 'bg-stone-900 text-[#F5EFEB] border-stone-900' : 'bg-white/80 text-stone-700 border-stone-300/80 hover:bg-white'
  }`;

function TranscriptStatusNote({ edition, strings }: { edition: VideoEdition; strings: ZueytubeStrings }) {
  const text = edition.transcript_status === 'unavailable' ? strings.transcriptUnavailable
    : edition.transcript_status === 'failed' ? strings.transcriptFailed : strings.transcriptPending;
  return <p className="text-sm text-stone-500 py-3">{text}</p>;
}

/** Player + language switch + transcript (click a timestamp to jump) + related articles. */
export const ZueytubePlayer: React.FC<ZueytubePlayerProps> = ({ video, related, editionId, onEdition, loading, failed, strings, locale }) => {
  const edition = video.editions.find(e => e.youtube_id === editionId) ?? video.editions[0];
  const [start, setStart] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setStart(null); setFilter(''); setExpanded(false); }, [edition.youtube_id]);

  const segments = useMemo(() => transcriptSegments(edition.transcript), [edition.transcript]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? segments.filter(s => s.text.toLowerCase().includes(q)) : segments;
  }, [segments, filter]);

  // Changing src (with autoplay) is how a timestamp click seeks without the YouTube JS API.
  const src = start === null ? embedUrl(edition.youtube_id) : `${embedUrl(edition.youtube_id, start)}&autoplay=1`;
  const meta = [formatDuration(edition.duration_seconds), formatVideoDate(edition.published_at, locale)].filter(Boolean).join(' · ');
  const description = edition.description.trim();
  const longDescription = description.length > 280;

  return (
    <article className="flex flex-col gap-4 min-w-0">
      <div className="relative w-full overflow-hidden rounded-2xl bg-black shadow-md" style={{ aspectRatio: '16 / 9' }}>
        <iframe
          key={`${edition.youtube_id}-${start ?? 'x'}`}
          src={src}
          title={edition.title}
          className="absolute inset-0 h-full w-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
          loading="lazy"
        />
      </div>

      <div className="flex flex-col gap-2 min-w-0">
        {video.editions.length > 1 && (
          <div className="flex items-center gap-2" role="group" aria-label={strings.language}>
            {video.editions.map(e => (
              <button key={e.youtube_id} type="button" className={pill(e.youtube_id === edition.youtube_id)} aria-pressed={e.youtube_id === edition.youtube_id} onClick={() => onEdition(e.youtube_id)}>
                {e.locale.toUpperCase()}
              </button>
            ))}
          </div>
        )}
        <h2 className="font-serif text-xl sm:text-2xl font-black leading-snug text-stone-900 break-words">{edition.title}</h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
          {meta && <span>{meta}</span>}
          <a href={edition.watch_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-red-700 hover:text-red-900">
            {strings.watchOnYoutube} <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>
        {description && (
          <div className="text-sm text-stone-700 leading-relaxed whitespace-pre-line break-words">
            {longDescription && !expanded ? `${description.slice(0, 280)}…` : description}
            {longDescription && (
              <button type="button" onClick={() => setExpanded(v => !v)} className="ml-1 text-xs font-semibold text-stone-500 hover:text-stone-900">
                {expanded ? strings.showLess : strings.showMore}
              </button>
            )}
          </div>
        )}
      </div>

      <section className="bg-white/80 border border-stone-200/90 rounded-2xl p-3 sm:p-4 min-w-0" aria-label={strings.transcript}>
        <div className="flex items-center justify-between gap-3 mb-2">
          <h3 className="text-sm font-bold text-stone-900">{strings.transcript}</h3>
          {segments.length > 0 && (
            <input
              type="search"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder={strings.transcriptFilter}
              aria-label={strings.transcriptFilter}
              className="w-40 sm:w-56 min-w-0 rounded-xl border border-stone-300/80 bg-white px-3 py-1.5 text-xs text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-red-300"
            />
          )}
        </div>
        {loading ? (
          <p className="text-sm text-stone-500 py-3">{strings.loading}</p>
        ) : failed ? (
          <p className="text-sm text-stone-500 py-3">{strings.loadFailed}</p>
        ) : segments.length === 0 ? (
          <TranscriptStatusNote edition={edition} strings={strings} />
        ) : (
          <>
            {edition.transcript_rewrite_status === 'ready' && <p className="text-[11px] text-stone-500 mb-2">{strings.transcriptRewritten}</p>}
            <ol className="max-h-80 overflow-y-auto pr-1 flex flex-col gap-1.5 text-sm leading-relaxed text-stone-700">
              {shown.map((seg, i) => (
                <li key={`${seg.start}-${i}`} className="flex gap-2.5">
                  <button
                    type="button"
                    onClick={() => setStart(seg.start)}
                    className="shrink-0 font-mono text-[11px] font-bold text-red-700 hover:text-red-900 tabular-nums pt-0.5"
                    aria-label={`${strings.jumpTo} ${seg.label}`}
                  >
                    {seg.label}
                  </button>
                  <span className="break-words min-w-0">{seg.text}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      <section aria-label={strings.related}>
        <h3 className="text-sm font-bold text-stone-900 mb-2">{strings.related}</h3>
        {related === null ? (
          <p className="text-sm text-stone-500">{loading ? strings.loading : strings.noRelated}</p>
        ) : related.length === 0 ? (
          <p className="text-sm text-stone-500">{strings.noRelated}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {related.map(a => (
              <li key={a.article_id} className="bg-white/80 border border-stone-200/90 rounded-2xl p-3 min-w-0">
                <a href={a.url} className="font-serif font-bold text-stone-900 hover:text-amber-700 break-words inline-flex items-center gap-1.5">
                  {a.access === 'knowledges' && <Lock size={12} aria-label={strings.members} />}
                  {a.title}
                </a>
                {a.excerpt && <p className="text-xs text-stone-600 mt-1 line-clamp-2 break-words">{a.excerpt}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
};
