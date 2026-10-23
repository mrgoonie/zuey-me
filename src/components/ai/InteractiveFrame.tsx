import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Play, RefreshCw, X } from 'lucide-react';
import './zuey-ai.css';
import type { InteractiveBlock } from '../../lib/blocks/schema';
import { LIMITS } from '../../lib/blocks/schema';
import type { Locale } from '../../lib/i18n/locales';
import { DEFAULT_LOCALE } from '../../lib/i18n/locales';
import { SANDBOX_CHANNEL, SANDBOX_SANDBOX_ATTR, buildSandboxSrcdoc } from '../../lib/ai/sandbox-doc';
import { AI_COPY } from './copy';
import { scheduleFrameStart } from './frame-start-queue';

export const READY_TIMEOUT_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 8_000;
export const MAX_FETCHES_PER_RUN = 50;
export const MAX_CONCURRENT_FETCHES = 4;
/** Published readers start a widget slightly before it scrolls into view, like third-party embeds. */
export const INTERACTIVE_PRELOAD_MARGIN = '200px 0px';
const MAX_SRCDOC_CHARS = LIMITS.interactiveTotal + 8_000;

type FrameState = 'idle' | 'running' | 'unresponsive';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clampHeight(h: number): number {
  return Math.max(LIMITS.interactiveHeightMin, Math.min(LIMITS.interactiveHeightMax, Math.round(h)));
}

interface FrameProps {
  block: InteractiveBlock;
  /** Start immediately (chat artifacts) instead of click-to-run (Studio previews). */
  autoRun?: boolean;
  /**
   * Start once, when the frame comes near the viewport (published article and lesson readers). Starts are
   * spaced out across frames; without IntersectionObserver the frame stays click-to-run.
   */
  runWhenVisible?: boolean;
  locale?: Locale;
  /** Hide the "open full screen" action (used inside the full-screen dialog itself). */
  inDialog?: boolean;
}

/**
 * Runs an interactive block in `<iframe sandbox="allow-scripts">` (opaque origin, strict CSP).
 * The parent only answers messages from this exact frame window; network requests are brokered
 * by POST /api/v1/sandbox/fetch. A ready/heartbeat watchdog unloads frames that stop responding.
 */
export function InteractiveFrame({ block, autoRun = false, runWhenVisible = false, locale = DEFAULT_LOCALE, inDialog = false }: FrameProps) {
  const t = AI_COPY[locale];
  const [state, setState] = useState<FrameState>(autoRun ? 'running' : 'idle');
  const [runId, setRunId] = useState(0);
  const [height, setHeight] = useState(clampHeight(block.height ?? 320));
  const [frameError, setFrameError] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const srcdoc = useMemo(() => buildSandboxSrcdoc(block), [block]);
  const tooLarge = srcdoc.length > MAX_SRCDOC_CHARS;

  const reply = useCallback((message: Record<string, unknown>) => {
    // Opaque-origin frames can only be addressed with '*'; the target window is this exact frame.
    frameRef.current?.contentWindow?.postMessage({ channel: SANDBOX_CHANNEL, ...message }, '*');
  }, []);

  useEffect(() => {
    if (state !== 'running' || tooLarge) return;
    let ready = false;
    let lastBeat = Date.now();
    let fetches = 0;
    let inFlight = 0;
    const halt = () => setState('unresponsive');
    const readyTimer = window.setTimeout(() => { if (!ready) halt(); }, READY_TIMEOUT_MS);
    const watchdog = window.setInterval(() => {
      // Background tabs throttle timers inside the frame: only judge while visible.
      if (ready && document.visibilityState === 'visible' && Date.now() - lastBeat > HEARTBEAT_TIMEOUT_MS) halt();
    }, 2_000);
    const onVisible = () => { if (document.visibilityState === 'visible') lastBeat = Date.now(); };
    document.addEventListener('visibilitychange', onVisible);

    const onMessage = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const data: unknown = event.data;
      if (!isRecord(data) || data.channel !== SANDBOX_CHANNEL) return;
      lastBeat = Date.now();
      switch (data.type) {
        case 'ready': ready = true; break;
        case 'heartbeat': break;
        case 'resize':
          if (typeof data.height === 'number' && Number.isFinite(data.height)) setHeight(clampHeight(data.height + 4));
          break;
        case 'error':
          setFrameError(typeof data.message === 'string' ? data.message.slice(0, 300) : 'error');
          break;
        case 'fetch': {
          const id = typeof data.id === 'number' ? data.id : null;
          if (id === null) return;
          if (typeof data.url !== 'string' || fetches >= MAX_FETCHES_PER_RUN || inFlight >= MAX_CONCURRENT_FETCHES) {
            reply({ type: 'fetch:result', id, ok: false, error: 'request limit reached' });
            return;
          }
          fetches += 1;
          inFlight += 1;
          fetch('/api/v1/sandbox/fetch', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ url: data.url }),
          })
            .then(async res => {
              const body: unknown = await res.json().catch(() => null);
              const payload = isRecord(body) && isRecord(body.data) ? body.data : null;
              if (res.ok && payload) {
                reply({ type: 'fetch:result', id, ok: true, status: payload.status, contentType: payload.content_type, body: payload.body });
              } else {
                const error = isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string' ? body.error.code : `http_${res.status}`;
                reply({ type: 'fetch:result', id, ok: false, error });
              }
            })
            .catch(() => reply({ type: 'fetch:result', id, ok: false, error: 'network_error' }))
            .finally(() => { inFlight -= 1; });
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.clearTimeout(readyTimer);
      window.clearInterval(watchdog);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('message', onMessage);
    };
  }, [state, runId, tooLarge, reply]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (full && !dialog.open) dialog.showModal();
    if (!full && dialog.open) dialog.close();
  }, [full]);

  const run = useCallback(() => {
    setFrameError(null);
    setState('running');
    setRunId(n => n + 1);
  }, []);

  // Automatic start happens once, from the idle state only: a frame halted by the watchdog, or one the reader
  // already started, never restarts by itself, and scrolling away and back keeps the running frame as it is.
  // A frame inside a closed toggle is not rendered, so it is not intersecting until the toggle opens.
  // While the full-screen copy runs, the inline one waits, so the widget never runs twice at once.
  useEffect(() => {
    if (!runWhenVisible || state !== 'idle' || tooLarge || full) return;
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    let cancelStart: (() => void) | null = null;
    const io = new IntersectionObserver(entries => {
      if (cancelStart || !entries.some(e => e.isIntersecting)) return;
      io.disconnect();
      cancelStart = scheduleFrameStart(run);
    }, { rootMargin: INTERACTIVE_PRELOAD_MARGIN });
    io.observe(el);
    return () => {
      io.disconnect();
      cancelStart?.();
    };
  }, [runWhenVisible, state, tooLarge, full, run]);

  return (
    <figure ref={rootRef} className="zif" aria-label={`${t.artifact}: ${block.title}`}>
      <div className="zif-head">
        <span className="zif-title">{block.title}</span>
        <span className="zif-actions">
          {state === 'running' ? (
            <button type="button" onClick={run}><RefreshCw size={14} aria-hidden="true" />{t.reload}</button>
          ) : (
            <button type="button" onClick={run}><Play size={14} aria-hidden="true" />{t.runDemo}</button>
          )}
          {!inDialog && (
            <button type="button" ref={openerRef} onClick={() => setFull(true)}><Maximize2 size={14} aria-hidden="true" />{t.openFull}</button>
          )}
        </span>
      </div>
      {tooLarge ? (
        <p className="zif-note zif-note-error">{t.artifactRejected}</p>
      ) : state === 'running' ? (
        <iframe
          key={runId}
          ref={frameRef}
          title={block.title}
          sandbox={SANDBOX_SANDBOX_ATTR}
          srcDoc={srcdoc}
          referrerPolicy="no-referrer"
          allow=""
          style={{ height }}
        />
      ) : (
        // A frame that will start by itself reserves its starting height, so mounting it shifts nothing.
        <div className="zif-placeholder" style={runWhenVisible && state === 'idle' ? { minHeight: height } : undefined}>
          {block.caption && <span>{block.caption}</span>}
          {state === 'unresponsive' && <span role="status">{t.unresponsive}</span>}
        </div>
      )}
      {frameError && state === 'running' && <p className="zif-note zif-note-error" role="status">{t.frameError}: {frameError}</p>}
      <figcaption className="zif-note">{block.caption && state === 'running' ? `${block.caption} · ` : ''}{t.sandboxNote}</figcaption>
      {!inDialog && (
        <dialog
          ref={dialogRef}
          className="zai-dialog zif-full"
          aria-label={block.title}
          onClose={() => { setFull(false); openerRef.current?.focus(); }}
        >
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.4rem' }}>
            <button type="button" className="zai-btn zai-btn-ghost" onClick={() => setFull(false)}><X size={16} aria-hidden="true" />{t.close}</button>
          </div>
          {full && <InteractiveFrame block={block} autoRun locale={locale} inDialog />}
        </dialog>
      )}
    </figure>
  );
}

export default InteractiveFrame;
