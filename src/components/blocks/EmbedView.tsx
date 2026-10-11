import { useEffect, useRef, useState } from 'react';
import type { EmbedBlock } from '../../lib/blocks/schema';
import { embedFrame, embedResizeHeight, embedSrc, PROVIDER_LABELS } from '../../lib/blocks/embed';

/** Per-device reader choice: `click` keeps every embed behind a button on this browser. */
export type EmbedLoadPref = 'auto' | 'click';

export const EMBED_PREF_KEY = 'zuey:embeds';
const EMBED_PREF_EVENT = 'zuey:embeds-pref';
/** Start loading slightly before the frame scrolls into view so it is ready when the reader gets there. */
const PRELOAD_MARGIN = '200px 0px';
/** A frame that has not fired `load` by then is treated as blocked or broken and replaced by the link. */
const LOAD_TIMEOUT_MS = 15000;

/** In-memory copy for browsers where localStorage throws (private mode, storage disabled). */
let memoryPref: EmbedLoadPref | null = null;

function readEmbedPref(): EmbedLoadPref {
  if (memoryPref) return memoryPref;
  try {
    return window.localStorage.getItem(EMBED_PREF_KEY) === 'click' ? 'click' : 'auto';
  } catch {
    return 'auto';
  }
}

function writeEmbedPref(pref: EmbedLoadPref): void {
  memoryPref = pref;
  try {
    if (pref === 'click') window.localStorage.setItem(EMBED_PREF_KEY, 'click');
    else window.localStorage.removeItem(EMBED_PREF_KEY);
  } catch {
    // Storage unavailable: the choice still applies to this page through memoryPref.
  }
  window.dispatchEvent(new Event(EMBED_PREF_EVENT));
}

/** Reader preference, null until mounted (SSR and the first client render show the placeholder). */
function useEmbedPref(): EmbedLoadPref | null {
  const [pref, setPref] = useState<EmbedLoadPref | null>(null);
  useEffect(() => {
    const sync = () => setPref(readEmbedPref());
    const onStorage = (e: StorageEvent) => { if (e.key === EMBED_PREF_KEY || e.key === null) { memoryPref = null; sync(); } };
    sync();
    window.addEventListener(EMBED_PREF_EVENT, sync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EMBED_PREF_EVENT, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return pref;
}

interface EmbedViewProps {
  block: EmbedBlock;
  /** True on public pages: frames load on their own when scrolled into view. False keeps click-to-load (editor previews). */
  autoLoad: boolean;
}

type LoadStatus = 'pending' | 'loaded' | 'failed';

/**
 * Third-party embed in a centred, provider-sized box. The frame's final shape is reserved before the
 * iframe exists (no layout shift); the original URL stays one click away in every state.
 */
export function EmbedView({ block, autoLoad }: EmbedViewProps) {
  const src = embedSrc(block.url, block.provider);
  const label = PROVIDER_LABELS[block.provider];
  const shape = embedFrame(block.provider, block.url);
  const pref = useEmbedPref();
  const rootRef = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [inView, setInView] = useState(false);
  const [requested, setRequested] = useState(false);
  const [status, setStatus] = useState<LoadStatus>('pending');
  const [height, setHeight] = useState<number | null>(null);

  const auto = autoLoad && pref === 'auto';
  // Before hydration (pref null) a public embed shows the "loads when scrolled to" note, not a dead button.
  const clickMode = !autoLoad || pref === 'click';
  const mounted = src !== null && status !== 'failed' && (requested || (auto && inView));

  // A different URL is a different embed: start over (and wait for a click again in click mode).
  useEffect(() => {
    setStatus('pending');
    setHeight(null);
    setRequested(false);
  }, [src]);

  useEffect(() => {
    if (!src || !auto || inView) return;
    const el = rootRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        setInView(true);
        io.disconnect();
      }
    }, { rootMargin: PRELOAD_MARGIN });
    io.observe(el);
    return () => io.disconnect();
  }, [src, auto, inView]);

  // An unmounted frame (reader switched to click-to-load) must load again from scratch when re-requested.
  useEffect(() => {
    if (!mounted) setStatus(s => (s === 'loaded' ? 'pending' : s));
  }, [mounted]);

  useEffect(() => {
    if (!mounted || status === 'loaded') return;
    const timer = window.setTimeout(() => setStatus('failed'), LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [mounted, status]);

  useEffect(() => {
    if (!mounted || shape !== 'post') return;
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const next = embedResizeHeight(block.provider, e.origin, e.data);
      if (next !== null) setHeight(next);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [mounted, shape, block.provider]);

  const retry = () => {
    setStatus('pending');
    setRequested(true);
  };

  const original = (
    <a href={block.url} target="_blank" rel="noopener noreferrer nofollow">Mở bài gốc trên {label}</a>
  );

  if (!src) {
    return (
      <figure className="zb-figure zb-embed">
        <div className="zb-embed-fallback">
          <span className="zb-embed-provider">{label}</span>
          <a href={block.url} target="_blank" rel="noopener noreferrer nofollow">Mở liên kết</a>
        </div>
        {block.caption && <figcaption>{block.caption}</figcaption>}
      </figure>
    );
  }

  const frameState = status === 'failed' ? ' is-failed' : mounted && status !== 'loaded' ? ' is-loading' : '';
  return (
    <figure ref={rootRef} className={`zb-figure zb-embed zb-embed-${shape} zb-embed-${block.provider}`}>
      <div className={`zb-embed-frame zb-ratio-${shape}${frameState}`} style={height !== null && status !== 'failed' ? { height } : undefined}>
        {mounted && (
          <iframe
            ref={frameRef}
            src={src}
            title={block.caption || `${label} embed`}
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
            allow="encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            onLoad={() => setStatus('loaded')}
          />
        )}
        {status === 'failed' ? (
          <div className="zb-embed-placeholder" role="status">
            <span>Không tải được nội dung từ {label}. Bài có thể đã bị xoá, ở chế độ riêng tư hoặc bị trình chặn quảng cáo chặn.</span>
            <span className="zb-embed-actions">
              {original}
              <button type="button" className="zb-btn" onClick={retry}>Thử lại</button>
            </span>
          </div>
        ) : mounted ? (
          status !== 'loaded' && <div className="zb-embed-placeholder" aria-hidden="true">Đang tải nội dung từ {label}…</div>
        ) : (
          <div className="zb-embed-placeholder">
            {clickMode
              ? <button type="button" className="zb-btn" onClick={() => setRequested(true)}>Tải nội dung từ {label}</button>
              : <span>Nội dung từ {label} sẽ tự tải khi bạn cuộn tới.</span>}
          </div>
        )}
      </div>
      {block.caption && <figcaption>{block.caption}</figcaption>}
      <div className="zb-embed-meta">
        {original}
        {autoLoad && pref !== null && (
          <button type="button" className="zb-embed-pref" onClick={() => writeEmbedPref(pref === 'auto' ? 'click' : 'auto')}>
            {pref === 'auto' ? 'Không tự tải nội dung nhúng trên thiết bị này' : 'Tự tải nội dung nhúng trên thiết bị này'}
          </button>
        )}
      </div>
    </figure>
  );
}
