/**
 * Engagement events for a published article page, read from `[data-article-analytics]` (slug, locale,
 * access, lock state and counts: no reader data). Draft previews render no such element and send nothing.
 *
 * - `article_opened` on load; `article_unlocked` when a members-only article is shown in full.
 * - `paywall_viewed` the first time the lockbox scrolls into view.
 * - `article_engaged` once the page has been visible for ENGAGED_SECONDS and half the readable body seen.
 */
import { trackOnce } from '../lib/analytics/client';
import { depthBucket, isEngaged, scrollDepth } from '../lib/analytics/engagement';

function count(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export interface EngagementTracker {
  /** One second of visible reading time. */
  tick(): void;
  /** Latest scroll depth of the readable body (0–100); the deepest one counts. */
  observeDepth(percent: number): void;
  readonly done: boolean;
}

/** Counts visible seconds and the deepest scroll, and calls `onEngaged` once both thresholds are met. */
export function createEngagementTracker(onEngaged: (seconds: number, depth: number) => void): EngagementTracker {
  let seconds = 0;
  let depth = 0;
  let done = false;
  const check = () => {
    if (done || !isEngaged(seconds, depth)) return;
    done = true;
    onEngaged(seconds, depthBucket(depth));
  };
  return {
    tick() { seconds += 1; check(); },
    observeDepth(percent) { depth = Math.max(depth, percent); check(); },
    get done() { return done; },
  };
}

export function initArticleAnalytics(doc: Document = document): void {
  const el = doc.querySelector<HTMLElement>('[data-article-analytics]');
  const slug = el?.dataset.slug;
  const locale = el?.dataset.locale;
  const access = el?.dataset.access;
  if (!el || !slug || !locale || !access) return;
  const locked = el.dataset.locked === '1';
  const base = { slug, locale };

  trackOnce('article_opened', 'article_opened', { ...base, access, locked, reading_minutes: count(el.dataset.readingMinutes) });
  if (access === 'knowledges' && !locked) trackOnce('article_unlocked', 'article_unlocked', base);

  const win = doc.defaultView;
  if (!win) return;

  const lockbox = doc.querySelector('.zb-lockbox');
  if (lockbox && typeof win.IntersectionObserver === 'function') {
    const io = new win.IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      trackOnce('paywall_viewed', 'paywall_viewed', { ...base, locked_sections: count(el.dataset.lockedSections) });
      io.disconnect();
    }, { threshold: 0.4 });
    io.observe(lockbox);
  }

  const body = doc.querySelector('[data-ask-ai-scope]');
  if (!body) return;
  const tracker = createEngagementTracker((seconds, depth) => {
    trackOnce('article_engaged', 'article_engaged', { ...base, access, seconds, depth });
  });
  const measure = () => tracker.observeDepth(scrollDepth(body.getBoundingClientRect(), win.innerHeight));
  const timer = win.setInterval(() => {
    if (doc.visibilityState !== 'visible') return;
    tracker.tick();
    if (tracker.done) stop();
  }, 1000);
  const onScroll = () => { measure(); if (tracker.done) stop(); };
  function stop() {
    win?.clearInterval(timer);
    win?.removeEventListener('scroll', onScroll);
  }
  win.addEventListener('scroll', onScroll, { passive: true });
  measure();
}
