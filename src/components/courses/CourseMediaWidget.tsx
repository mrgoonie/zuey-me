import { useCallback, useEffect, useRef, useState } from 'react';
import type { CourseMediaBlock } from '../../lib/courses/lesson-blocks';
import { alertError, btnGhost, btnPrimary, isRecord, jsonBody, str, strOrNull } from '../members/member-ui';
import { courseApi, lessonApiBase, widgetCard } from './course-ui';

interface Signed { kind: 'video' | 'audio' | 'file'; name: string; mime: string | null; size: number | null; url: string; expiresAt: number }

function parseSigned(v: unknown): Signed | null {
  if (!isRecord(v) || !str(v, 'url')) return null;
  const kind = str(v, 'kind');
  const expiresAt = Date.parse(str(v, 'expires_at'));
  return {
    kind: kind === 'video' || kind === 'audio' ? kind : 'file',
    name: str(v, 'name'), mime: strOrNull(v, 'mime'),
    size: typeof v.size_bytes === 'number' ? v.size_bytes : null,
    url: str(v, 'url'),
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 5 * 60_000,
  };
}

function fmtSize(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Private lesson media. A short-lived signed URL is requested when the widget scrolls into view and
 * requested again when it expires or playback fails; the URL is never stored in the page.
 */
export function CourseMediaWidget({ block, courseSlug, lessonSlug }: { block: CourseMediaBlock; courseSlug: string; lessonSlug: string }) {
  const [media, setMedia] = useState<Signed | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const retried = useRef(false);

  const sign = useCallback(async (): Promise<Signed | null> => {
    setBusy(true); setError(null);
    const res = await courseApi(`${lessonApiBase(courseSlug, lessonSlug)}/media`, { method: 'POST', body: jsonBody({ asset_id: block.assetId }) });
    setBusy(false);
    const parsed = res.ok ? parseSigned(res.data) : null;
    if (!parsed) { setError(res.ok ? 'Phản hồi không hợp lệ từ máy chủ.' : res.message); return null; }
    setMedia(parsed); setExpired(false);
    return parsed;
  }, [block.assetId, courseSlug, lessonSlug]);

  // Load lazily once visible.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || media || error) return;
    if (!('IntersectionObserver' in window)) { void sign(); return; }
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { io.disconnect(); void sign(); }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [media, error, sign]);

  // Mark the URL stale at expiry: players keep running, but the next download or reload asks for a fresh one.
  useEffect(() => {
    if (!media) return;
    const id = window.setTimeout(() => setExpired(true), Math.max(0, media.expiresAt - Date.now()));
    return () => window.clearTimeout(id);
  }, [media]);

  async function download() {
    const fresh = !media || expired || media.expiresAt - Date.now() < 15_000 ? await sign() : media;
    if (fresh) window.location.assign(fresh.url);
  }

  async function onPlaybackError() {
    if (retried.current) { setError('Không phát được nội dung. Vui lòng tải lại.'); return; }
    retried.current = true;
    await sign();
  }

  const title = block.title || media?.name || 'Nội dung bài học';

  return (
    <figure ref={rootRef} className={widgetCard}>
      <p className="mb-2 font-serif text-lg font-bold break-words">{title}</p>
      {media?.kind === 'video' && (
        <div className="relative w-full overflow-hidden rounded-xl bg-stone-900" style={{ aspectRatio: '16 / 9' }}>
          <iframe
            key={media.url} src={media.url} title={title} loading="lazy" className="absolute inset-0 h-full w-full border-0"
            allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen
          />
        </div>
      )}
      {media?.kind === 'audio' && (
        <audio key={media.url} controls preload="metadata" controlsList="nodownload" src={media.url} className="w-full" onError={() => { void onPlaybackError(); }}>
          Trình duyệt của bạn không hỗ trợ phát âm thanh.
        </audio>
      )}
      {media?.kind === 'file' && (
        <p className="flex flex-wrap items-center gap-3">
          <button type="button" className={`${btnPrimary} min-h-[44px]`} onClick={() => { void download(); }} disabled={busy}>
            {busy ? 'Đang chuẩn bị…' : 'Tải tệp xuống'}
          </button>
          <span className="text-xs text-stone-600 break-all">{media.name}{fmtSize(media.size) && ` · ${fmtSize(media.size)}`}</span>
        </p>
      )}
      {media && expired && media.kind !== 'file' && (
        <p className="mt-2 flex flex-wrap items-center gap-3 text-xs text-stone-600">
          Liên kết phát đã hết hạn để bảo vệ nội dung; nếu trình phát dừng, hãy tải lại.
          <button type="button" className={`${btnGhost} min-h-[44px]`} onClick={() => { retried.current = false; void sign(); }} disabled={busy}>Tải lại</button>
        </p>
      )}
      {!media && !error && <p className="text-sm text-stone-600" role="status">{busy ? 'Đang tải nội dung…' : 'Nội dung sẽ tải khi bạn cuộn tới.'}</p>}
      <div role="status" aria-live="polite" className="empty:hidden mt-2">
        {error && (
          <div className="grid gap-2">
            <p className={alertError}>{error}</p>
            <p><button type="button" className={`${btnGhost} min-h-[44px]`} onClick={() => { retried.current = false; void sign(); }} disabled={busy}>Thử lại</button></p>
          </div>
        )}
      </div>
      {block.caption && <figcaption className="mt-2 text-sm text-stone-600 whitespace-pre-line">{block.caption}</figcaption>}
    </figure>
  );
}
