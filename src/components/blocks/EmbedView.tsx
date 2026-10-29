import { useEffect, useRef, useState } from 'react';
import type { EmbedBlock } from '../../lib/blocks/schema';
import { embedAnnouncesHeight, embedFrame, embedResizeHeight, embedSrc, PROVIDER_LABELS } from '../../lib/blocks/embed';

/** Per-device reader choice: `click` keeps every embed behind a button on this browser. */
export type EmbedLoadPref = 'auto' | 'click';

export const EMBED_PREF_KEY = 'zuey:embeds';
const EMBED_PREF_EVENT = 'zuey:embeds-pref';
/** Start loading slightly before the frame scrolls into view so it is ready when the reader gets there. */
export const EMBED_PRELOAD_MARGIN = '200px 0px';
/**
 * A frame that has not signalled readiness by then gets a non-blocking notice with the original link.
 * The frame itself stays mounted: slow but working embeds still appear when they finish.
 */
export const EMBED_SLOW_MS = 15000;

/** In-memory copy for browsers where localStorage throws (private mode, storage disabled). */
let memoryPref: EmbedLoadPref | null = null;

/** The reader's stored choice (client only). Widget auto-start honours `click` too. */
export function readEmbedPref(): EmbedLoadPref {
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

/**
 * Third-party embed in a centred, provider-sized box. The frame's final shape is reserved before the
 * iframe exists (no layout shift); the original URL stays one click away in every state.
 * Render with `key={block.url}` so a different URL starts from a clean state.
 */
export function EmbedView({ block, autoLoad }: EmbedViewProps) {
  const src = embedSrc(block.url, block.provider);
  const label = PROVIDER_LABELS[block.provider];
  const shape = embedFrame(block.provider, block.url);
  const announcesHeight = embedAnnouncesHeight(block.provider);
  const pref = useEmbedPref();
  const rootRef = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [inView, setInView] = useState(false);
  const [requested, setRequested] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [height, setHeight] = useState<number | null>(null);
  const [slow, setSlow] = useState(false);

  const auto = autoLoad && pref === 'auto';
  const clickMode = !autoLoad || pref === 'click';
  // Server markup and the first client render (pref null) promise nothing: without JavaScript nothing will
  // ever load, so only a <noscript> note pointing to the original post is shown until the script runs.
  const hydrated = pref !== null;
  const mounted = src !== null && (requested || (auto && inView));
  // `load` also fires for provider error pages, so frames that announce their height are ready only once they do.
  // Other providers (Facebook included) send no height messages: for them `load` is the only signal, so a
  // deleted or private Facebook post whose error page loads counts as ready and gets no slow notice.
  const ready = announcesHeight ? height !== null : loaded;

  const resetFrame = () => {
    setLoaded(false);
    setHeight(null);
    setSlow(false);
  };

  // An unmounted frame (reader switched to click-to-load) loads again from scratch when re-requested.
  useEffect(() => {
    if (!mounted) resetFrame();
  }, [mounted]);

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
    }, { rootMargin: EMBED_PRELOAD_MARGIN });
    io.observe(el);
    return () => io.disconnect();
  }, [src, auto, inView]);

  useEffect(() => {
    if (!mounted || ready) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), EMBED_SLOW_MS);
    return () => clearTimeout(timer);
  }, [mounted, ready, attempt]);

  useEffect(() => {
    if (!mounted || !announcesHeight) return;
    const onMessage = (e: MessageEvent) => {
      const win = frameRef.current?.contentWindow;
      if (!win || e.source !== win) return;
      const next = embedResizeHeight(block.provider, e.origin, e.data);
      if (next !== null) setHeight(next);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [mounted, announcesHeight, block.provider]);

  const retry = () => {
    resetFrame();
    setAttempt(a => a + 1);
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

  return (
    <figure ref={rootRef} className={`zb-figure zb-embed zb-embed-${shape} zb-embed-${block.provider}`}>
      <div className={`zb-embed-frame zb-ratio-${shape}${mounted && !loaded ? ' is-loading' : ''}`} style={height !== null ? { height } : undefined}>
        {mounted && (
          <iframe
            key={attempt}
            ref={frameRef}
            src={src}
            title={block.caption || `${label} embed`}
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            // Links in a post open the provider in a normal tab; without the escape flag that tab inherits
            // this sandbox and the provider's own pages break.
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"
            allow="encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            onLoad={() => setLoaded(true)}
          />
        )}
        {mounted ? (
          !loaded && <div className="zb-embed-placeholder" aria-hidden="true">Đang tải nội dung từ {label}…</div>
        ) : (
          <div className="zb-embed-placeholder">
            {clickMode
              ? <button type="button" className="zb-btn" onClick={() => setRequested(true)}>Tải nội dung từ {label}</button>
              : hydrated
                ? <span>Nội dung từ {label} sẽ tự tải khi bạn cuộn tới.</span>
                // The link to the original post is the one below the frame, shown in every state.
                : <noscript>Nội dung từ {label} cần JavaScript để hiển thị tại đây.</noscript>}
          </div>
        )}
      </div>
      {slow && !ready && (
        <p className="zb-embed-notice" role="status">
          <span>{label} chưa hiển thị nội dung. Bài có thể đã bị xoá, ở chế độ riêng tư hoặc bị trình chặn quảng cáo chặn.</span>
          <span className="zb-embed-actions">
            {original}
            <button type="button" className="zb-embed-link-btn" onClick={retry}>Thử lại</button>
          </span>
        </p>
      )}
      {block.caption && <figcaption>{block.caption}</figcaption>}
      <div className="zb-embed-meta">
        {original}
        {autoLoad && (
          // Rendered from the first paint so it never shifts the line, but invisible and disabled until the
          // stored choice is read: without JavaScript it would be a button that can never work.
          <button type="button" className="zb-embed-link-btn" disabled={pref === null}
            style={pref === null ? { visibility: 'hidden' } : undefined}
            onClick={() => writeEmbedPref(pref === 'click' ? 'auto' : 'click')}>
            {pref === 'click' ? 'Tự tải nội dung nhúng trên thiết bị này' : 'Không tự tải nội dung nhúng trên thiết bị này'}
          </button>
        )}
      </div>
    </figure>
  );
}
