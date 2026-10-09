import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Sparkles } from 'lucide-react';
import type { Locale } from '../../lib/i18n/locales';
import { trackEvent } from '../../lib/posthog';
import type { ArticleChatContext } from './article-chat-context';
import { MAX_SELECTION_CHARS, MIN_SELECTION_CHARS, normalizeQuote, readPendingQuote, savePendingQuote } from './article-chat-context';
import './article-ask-ai.css';

// The chat panel (and its CSS) is fetched only when a reader first asks; the article page stays light.
const ZueyAiPanel = lazy(() => import('./ZueyAiPanel'));

interface Props {
  locale: Locale;
  slug: string;
  title: string;
  /** Canonical article URL, cited in the question sent to Zuey AI. */
  url: string;
  /** Selector of the element holding the readable article body (selections elsewhere are ignored). */
  scopeSelector: string;
  /** Strings from AI_COPY, passed in so the article bundle does not carry every locale's copy. */
  labels: { ask: string; drawerTitle: string; loading: string };
}

interface Tip { left: number; top: number; below: boolean }

const TIP_GAP = 10;
const TIP_HEIGHT = 40;

/** Text selected inside `scope` (normalized) and its bounding box, or null when it should get no tooltip. */
function readSelection(scope: Element): { text: string; rect: DOMRect } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const inScope = (node: Node) => scope.contains(node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode);
  if (!inScope(range.startContainer) || !inScope(range.endContainer)) return null;
  const common = range.commonAncestorContainer;
  const host = common.nodeType === Node.ELEMENT_NODE ? (common as Element) : common.parentElement;
  if (host?.closest('input, textarea, select, button, iframe, [contenteditable="true"]')) return null;
  const text = normalizeQuote(sel.toString());
  if (text.length < MIN_SELECTION_CHARS || text.length > MAX_SELECTION_CHARS) return null;
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { text, rect };
}

/**
 * "Ask Zuey AI" for article readers: selecting text in the article body shows a small tooltip; it opens
 * a drawer (side panel on desktop, bottom sheet on phones) with the Zuey AI panel, the passage attached
 * as a quote and the composer focused. Nothing is sent until the reader types a question.
 */
export function ArticleAskAi({ locale, slug, title, url, scopeSelector, labels }: Props) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [quote, setQuote] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const selected = useRef<string | null>(null);
  const scopeRef = useRef<HTMLElement | null>(null);

  const openWith = useCallback((text: string | null) => {
    setQuote(text);
    setNonce(n => n + 1);
    setMounted(true);
    setOpen(true);
  }, []);

  // A passage saved before signing in (magic links open in a new tab) reopens the drawer on return.
  useEffect(() => {
    scopeRef.current = document.querySelector<HTMLElement>(scopeSelector);
    const pending = readPendingQuote(slug);
    if (pending) openWith(pending);
  }, [scopeSelector, slug, openWith]);

  useEffect(() => {
    let timer = 0;
    let frame = 0;
    const coarse = window.matchMedia('(pointer: coarse)');
    const place = () => {
      const scope = scopeRef.current;
      const hit = scope ? readSelection(scope) : null;
      selected.current = hit?.text ?? null;
      if (!hit) { setTip(null); return; }
      const { rect } = hit;
      // Phones show their own copy/select menu above the selection, so the tooltip goes below there.
      const below = coarse.matches || rect.top < TIP_HEIGHT + TIP_GAP;
      const top = below ? rect.bottom + TIP_GAP : rect.top - TIP_HEIGHT - TIP_GAP;
      const left = Math.min(Math.max(rect.left + rect.width / 2, 90), window.innerWidth - 90);
      setTip({ left, top, below });
    };
    const onSelection = () => { window.clearTimeout(timer); timer = window.setTimeout(place, 150); };
    const onMove = () => { if (!selected.current) return; cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    document.addEventListener('selectionchange', onSelection);
    window.addEventListener('scroll', onMove, { passive: true });
    window.addEventListener('resize', onMove);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', onSelection);
      window.removeEventListener('scroll', onMove);
      window.removeEventListener('resize', onMove);
    };
  }, []);

  const ask = () => {
    const text = selected.current;
    if (!text) return;
    trackEvent('article_ask_ai_clicked', { slug, chars: text.length });
    savePendingQuote(slug, text);
    window.getSelection()?.removeAllRanges();
    selected.current = null;
    setTip(null);
    openWith(text);
  };

  const close = useCallback(() => {
    setOpen(false);
    savePendingQuote(slug, null);
    // Back to the reading position, without scrolling the page.
    scopeRef.current?.focus({ preventScroll: true });
  }, [slug]);

  const onDrawerKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // The panel uses Escape to stop a running answer (it prevents default) and its own dialogs handle theirs.
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (e.target instanceof Element && e.target.closest('dialog')) return;
    e.preventDefault();
    close();
  };

  const context = useMemo<ArticleChatContext>(() => ({
    slug, title, url, quote, quoteNonce: nonce,
    onQuoteChange: next => savePendingQuote(slug, next),
  }), [slug, title, url, quote, nonce]);

  return (
    <>
      {tip && (
        <button
          type="button"
          className="zaa-tip"
          data-below={tip.below ? 'true' : 'false'}
          style={{ left: tip.left, top: tip.top }}
          // Keep the selection: a mousedown on a button would otherwise collapse it before the click.
          onPointerDown={e => e.preventDefault()}
          onMouseDown={e => e.preventDefault()}
          onClick={ask}
        >
          <Sparkles size={14} aria-hidden="true" />{labels.ask}
        </button>
      )}
      {mounted && (
        <div className="zaa-drawer" role="dialog" aria-modal="false" aria-label={labels.drawerTitle} hidden={!open} onKeyDown={onDrawerKey}>
          <Suspense fallback={<p className="zaa-loading" role="status">{labels.loading}</p>}>
            <ZueyAiPanel locale={locale} context={context} onClose={close} />
          </Suspense>
        </div>
      )}
    </>
  );
}

export default ArticleAskAi;
