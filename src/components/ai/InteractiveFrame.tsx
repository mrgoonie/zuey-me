import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { Maximize2, Play, RefreshCw, Square, X } from 'lucide-react';
import './zuey-ai.css';
import type { InteractiveBlock } from '../../lib/blocks/schema';
import { LIMITS } from '../../lib/blocks/schema';
import type { Locale } from '../../lib/i18n/locales';
import { DEFAULT_LOCALE } from '../../lib/i18n/locales';
import { SANDBOX_CHANNEL, SANDBOX_CSP, SANDBOX_SANDBOX_ATTR, buildSandboxSrcdoc, createFrameNonce } from '../../lib/ai/sandbox-doc';
import { readEmbedPref } from '../blocks/EmbedView';
import { AI_COPY } from './copy';
import { claimAutoRunSlot, releaseAutoRunSlot, scheduleFrameStart } from './frame-start-queue';

export const READY_TIMEOUT_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 8_000;
/** How long after the iframe's `load` the sandboxed document may take to report its own `load`. */
export const LOAD_HANDSHAKE_MS = 1_000;
/** How long after `ready` the sandboxed document may take to report its own `load`, visible or not. */
export const LOADED_AFTER_READY_MS = 5_000;
/** Longest silence tolerated while the reader's tab is hidden (frame timers may be throttled to once a minute). */
export const HIDDEN_HEARTBEAT_TIMEOUT_MS = 180_000;
export const MAX_FETCHES_PER_RUN = 50;
export const MAX_CONCURRENT_FETCHES = 4;
/** Published readers start a widget slightly before it scrolls into view, like third-party embeds. */
export const INTERACTIVE_PRELOAD_MARGIN = '200px 0px';
const MAX_SRCDOC_CHARS = LIMITS.interactiveTotal + 8_000;
/**
 * CSP Embedded Enforcement (`<iframe csp>`, Chromium): every document in the frame must accept the widget
 * policy, so a page the widget navigates to fails to load instead of running without it. React has no typed
 * prop for it, hence the spread.
 */
const EMBEDDED_CSP_ATTR: Record<string, string> = { csp: SANDBOX_CSP };

/** `navigated`: the widget navigated its own frame away from the sandboxed document and was halted. */
type FrameState = 'idle' | 'running' | 'unresponsive' | 'navigated';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clampHeight(h: number): number {
  return Math.max(LIMITS.interactiveHeightMin, Math.min(LIMITS.interactiveHeightMax, Math.round(h)));
}

/**
 * Well-known crawlers and link-preview fetchers that run scripts gain nothing from live widgets. Named on
 * purpose (a bare `bot` would also match phone brands); headless browsers and `navigator.webdriver` are not
 * matched, so browser smoke runs still exercise the automatic start.
 */
const BOT_USER_AGENT = /googlebot|bingbot|yandexbot|duckduckbot|baiduspider|applebot|petalbot|ahrefsbot|semrushbot|slurp|facebookexternalhit|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|embedly|crawler|spider/i;

/**
 * Whether this reader lets widgets start by themselves: not with `prefers-reduced-motion: reduce`, not when the
 * reader chose click-to-load for embeds on this device (`zuey:embeds=click`), and not for crawler user agents.
 */
export function autoStartAllowed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  } catch {
    // matchMedia unavailable: fall through to the other checks.
  }
  if (readEmbedPref() === 'click') return false;
  return !BOT_USER_AGENT.test(window.navigator.userAgent);
}

/** True while an ancestor toggle is closed: its content is not shown, whatever an observer reports. */
function insideClosedToggle(el: HTMLElement): boolean {
  return el.parentElement?.closest('details:not([open])') != null;
}

interface FrameProps {
  block: InteractiveBlock;
  /** Start immediately (chat artifacts) instead of click-to-run (Studio previews). */
  autoRun?: boolean;
  /**
   * Start once, when the frame comes near the viewport (published article and lesson readers). Starts are
   * spaced out across frames and capped per page; reduced motion, the reader's click-to-load choice, crawlers
   * and a missing IntersectionObserver keep the frame click-to-run. Stop keeps it stopped for this page view.
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
 * A widget that navigates its own frame is unloaded too: the iframe `csp` attribute makes Chromium refuse the
 * foreign page, and the parent halts on the bridge's `pagehide`, a second iframe `load`, or a document that
 * never reports its own load. Only messages carrying this run's nonce are answered.
 */
export function InteractiveFrame({ block, autoRun = false, runWhenVisible = false, locale = DEFAULT_LOCALE, inDialog = false }: FrameProps) {
  const t = AI_COPY[locale];
  const [state, setState] = useState<FrameState>(autoRun ? 'running' : 'idle');
  const [runId, setRunId] = useState(0);
  const [height, setHeight] = useState(clampHeight(block.height ?? 320));
  const [frameError, setFrameError] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  // Armed until the frame starts once (by itself or by the reader) or the reader stops it.
  const [autoArmed, setAutoArmed] = useState(runWhenVisible);
  // The frame reached the viewport while the page already ran the maximum of auto-started frames.
  const [capped, setCapped] = useState(false);
  const slotRef = useRef(false);
  const refocusRunRef = useRef(false);
  const runButtonRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  // A fresh nonce per run: messages from an earlier run's document, or from a document the frame navigated
  // to, never match the run that is listening.
  const { nonce, srcdoc } = useMemo(() => {
    const n = createFrameNonce();
    return { nonce: n, srcdoc: buildSandboxSrcdoc(block, n) };
  }, [block, runId]);
  const tooLarge = srcdoc.length > MAX_SRCDOC_CHARS;
  // The sandboxed document loads exactly once per run and says so with a nonce-tagged `loaded` message. A
  // second iframe `load`, or a `load` whose document never says `loaded` (the widget navigated before its own
  // document finished loading), means the frame now shows another document.
  const loadsRef = useRef(0);
  const docLoadedRef = useRef(false);
  const handshakeRef = useRef<number | null>(null);
  const clearHandshake = useCallback(() => {
    if (handshakeRef.current !== null) window.clearTimeout(handshakeRef.current);
    handshakeRef.current = null;
  }, []);
  const haltNavigated = useCallback(() => {
    clearHandshake();
    setState(s => (s === 'running' ? 'navigated' : s));
  }, [clearHandshake]);
  const onFrameLoad = useCallback((event: SyntheticEvent<HTMLIFrameElement>) => {
    // Only the frame of the current run counts (a removed frame can still report a late load).
    if (event.currentTarget !== frameRef.current) return;
    loadsRef.current += 1;
    if (loadsRef.current > 1) {
      haltNavigated();
    } else if (!docLoadedRef.current) {
      handshakeRef.current = window.setTimeout(() => { if (!docLoadedRef.current) haltNavigated(); }, LOAD_HANDSHAKE_MS);
    }
  }, [haltNavigated]);

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
    // Set by the cleanup: replies to requests of a halted, stopped or reloaded run are dropped, so they never
    // reach a document the frame navigated to or the next run's bridge.
    let cancelled = false;
    let loadedTimer: number | null = null;
    const halt = () => setState('unresponsive');
    const readyTimer = window.setTimeout(() => { if (!ready) halt(); }, READY_TIMEOUT_MS);
    const silentFor = () => Date.now() - lastBeat;
    const watchdog = window.setInterval(() => {
      if (!ready) return;
      // Background tabs throttle timers inside the frame: a hidden tab gets a long, but finite, allowance.
      if (silentFor() > (document.visibilityState === 'visible' ? HEARTBEAT_TIMEOUT_MS : HIDDEN_HEARTBEAT_TIMEOUT_MS)) halt();
    }, 2_000);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (ready && silentFor() > HIDDEN_HEARTBEAT_TIMEOUT_MS) halt();
      else lastBeat = Date.now();
    };
    document.addEventListener('visibilitychange', onVisible);

    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame) return;
      const data: unknown = event.data;
      // A document the frame navigated to shares its window but not the nonce: everything it posts is ignored.
      if (!isRecord(data) || data.channel !== SANDBOX_CHANNEL || data.nonce !== nonce) return;
      // Chromium delivers the last message of a document that is being navigated away with no source. Only
      // `leave` is accepted that way; the nonce proves it came from this run's document.
      if (event.source !== frame.contentWindow && !(event.source === null && data.type === 'leave')) return;
      lastBeat = Date.now();
      switch (data.type) {
        case 'ready':
          ready = true;
          // A document that never reports its own load (it navigated while parsing, or the page it landed on
          // never finishes loading) is halted even if the iframe never fires `load`.
          if (loadedTimer === null && !docLoadedRef.current) {
            loadedTimer = window.setTimeout(() => { if (!docLoadedRef.current) halt(); }, LOADED_AFTER_READY_MS);
          }
          break;
        case 'loaded':
          docLoadedRef.current = true;
          clearHandshake();
          break;
        // The sandboxed document is being unloaded while the widget runs: it navigated its own frame.
        case 'leave': haltNavigated(); break;
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
          const answer = (message: Record<string, unknown>) => { if (!cancelled) reply(message); };
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
                answer({ type: 'fetch:result', id, ok: true, status: payload.status, contentType: payload.content_type, body: payload.body });
              } else {
                const error = isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string' ? body.error.code : `http_${res.status}`;
                answer({ type: 'fetch:result', id, ok: false, error });
              }
            })
            .catch(() => answer({ type: 'fetch:result', id, ok: false, error: 'network_error' }))
            .finally(() => { inFlight -= 1; });
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      cancelled = true;
      window.clearTimeout(readyTimer);
      if (loadedTimer !== null) window.clearTimeout(loadedTimer);
      window.clearInterval(watchdog);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('message', onMessage);
    };
  }, [state, runId, tooLarge, reply, nonce, clearHandshake, haltNavigated]);

  // Leaving the running state (Stop, Reload, watchdog, unmount) drops a pending load handshake.
  useEffect(() => { if (state !== 'running') clearHandshake(); }, [state, clearHandshake]);
  useEffect(() => clearHandshake, [clearHandshake]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (full && !dialog.open) dialog.showModal();
    if (!full && dialog.open) dialog.close();
  }, [full]);

  const run = useCallback(() => {
    loadsRef.current = 0;
    docLoadedRef.current = false;
    clearHandshake();
    setFrameError(null);
    setState('running');
    setRunId(n => n + 1);
  }, [clearHandshake]);

  /** Reader-started run: never counted against the auto-start cap, and it disarms the automatic start. */
  const start = useCallback(() => {
    setAutoArmed(false);
    setCapped(false);
    run();
  }, [run]);

  /** Tears the frame down to its placeholder; nothing restarts it by itself during this page view. */
  const stop = useCallback(() => {
    setAutoArmed(false);
    setFrameError(null);
    refocusRunRef.current = true;
    setState('idle');
  }, []);

  // The Stop button disappears with the frame; keyboard focus moves to Run demo instead of being lost.
  useEffect(() => {
    if (state === 'idle' && refocusRunRef.current) {
      refocusRunRef.current = false;
      runButtonRef.current?.focus();
    }
  }, [state]);

  // An auto-started frame frees its slot when it stops running (Stop, watchdog halt) or unmounts.
  useEffect(() => {
    if (state !== 'running' && slotRef.current) {
      slotRef.current = false;
      releaseAutoRunSlot();
    }
  }, [state]);
  useEffect(() => () => {
    if (slotRef.current) {
      slotRef.current = false;
      releaseAutoRunSlot();
    }
  }, []);

  // Automatic start happens once, from the idle state only: a frame halted by the watchdog, stopped, or already
  // started by the reader never restarts by itself, and scrolling away and back keeps a running frame as it is.
  // A frame inside a closed toggle waits until the toggle opens. While the full-screen copy runs, the inline one
  // waits, so the widget never runs twice at once.
  useEffect(() => {
    if (!autoArmed || state !== 'idle' || tooLarge || full) return;
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined' || !autoStartAllowed()) return;
    let cancelStart: (() => void) | null = null;
    const io = new IntersectionObserver(entries => {
      if (cancelStart || !entries.some(e => e.isIntersecting) || insideClosedToggle(el)) return;
      io.disconnect();
      document.removeEventListener('toggle', onToggle, true);
      cancelStart = scheduleFrameStart(() => {
        setAutoArmed(false);
        if (!claimAutoRunSlot()) {
          setCapped(true);
          return;
        }
        slotRef.current = true;
        run();
      });
    }, { rootMargin: INTERACTIVE_PRELOAD_MARGIN });
    // Opening a toggle re-checks a frame that was already within the margin while hidden.
    const onToggle = (event: Event) => {
      if (!(event.target instanceof Node) || !event.target.contains(el) || insideClosedToggle(el)) return;
      io.unobserve(el);
      io.observe(el);
    };
    document.addEventListener('toggle', onToggle, true);
    io.observe(el);
    return () => {
      io.disconnect();
      document.removeEventListener('toggle', onToggle, true);
      cancelStart?.();
    };
  }, [autoArmed, state, tooLarge, full, run]);

  return (
    <figure ref={rootRef} className="zif" data-state={state !== 'idle' ? state : capped ? 'capped' : undefined} aria-label={`${t.artifact}: ${block.title}`}>
      <div className="zif-head">
        <span className="zif-title">{block.title}</span>
        <span className="zif-actions">
          {state === 'running' ? (
            <>
              <button type="button" onClick={run}><RefreshCw size={14} aria-hidden="true" />{t.reload}</button>
              {!inDialog && (
                <button type="button" onClick={stop} aria-label={`${t.stopDemo}: ${block.title}`}><Square size={14} aria-hidden="true" />{t.stopDemo}</button>
              )}
            </>
          ) : (
            <button type="button" ref={runButtonRef} onClick={start}><Play size={14} aria-hidden="true" />{t.runDemo}</button>
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
          {...EMBEDDED_CSP_ATTR}
          srcDoc={srcdoc}
          referrerPolicy="no-referrer"
          allow=""
          onLoad={onFrameLoad}
          style={{ height }}
        />
      ) : (
        // A frame that will start by itself reserves its starting height, so mounting it shifts nothing.
        <div className="zif-placeholder" style={runWhenVisible && state === 'idle' ? { minHeight: height } : undefined}>
          {block.caption && <span>{block.caption}</span>}
          {state === 'unresponsive' && <span role="status">{t.unresponsive}</span>}
          {state === 'navigated' && <span role="status">{t.leftSandbox}</span>}
          {state === 'idle' && capped && <span className="zif-note-limit">{t.autoRunLimit}</span>}
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
