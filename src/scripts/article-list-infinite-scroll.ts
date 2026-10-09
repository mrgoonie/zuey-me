/**
 * Infinite scroll for /articles that keeps Back/Forward honest.
 *
 * - The server renders pages 1..N for `?page=N`, so the URL alone rebuilds the list.
 * - When the "load more" link nears the viewport, the next page partial (/articles/page/{n}) is
 *   appended and the URL is replaced with `?page=n` (one replaceState per page, never per scroll).
 * - Leaving the page records an anchor (the card the reader clicked, otherwise the first card in view)
 *   in history.state. If the browser restores the page from bfcache nothing is needed; otherwise the
 *   freshly rendered list is scrolled so that card sits where it was.
 */

const LOAD_AHEAD_PX = 800;

export interface ListAnchor {
  slug: string;
  /** Card top relative to the viewport when the reader left. */
  top: number;
}

interface AnchorState {
  articleListAnchor?: ListAnchor;
}

function readAnchor(state: unknown): ListAnchor | null {
  if (typeof state !== 'object' || state === null || !('articleListAnchor' in state)) return null;
  const a = (state as AnchorState).articleListAnchor;
  return a && typeof a.slug === 'string' && typeof a.top === 'number' ? a : null;
}

function saveState(patch: AnchorState, url?: string): void {
  const prev = typeof history.state === 'object' && history.state !== null ? history.state : {};
  try {
    history.replaceState({ ...prev, ...patch }, '', url);
  } catch {
    // Some browsers throttle replaceState; losing one update only costs the restore precision.
  }
}

/** URL of page `n` of the same list (filters kept). */
export function listPageUrl(href: string, n: number): string {
  const url = new URL(href);
  if (n <= 1) url.searchParams.delete('page');
  else url.searchParams.set('page', String(n));
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Partial URL of page `n`, derived from the current partial URL (filters kept). */
export function partialPageUrl(partial: string, n: number): string {
  return partial.replace(/\/articles\/page\/\d+/, `/articles/page/${n}`);
}

/** The first row whose card is at least partly below the top of the viewport. */
function firstVisibleRow(list: HTMLElement): HTMLElement | null {
  for (const li of list.querySelectorAll<HTMLElement>('li[data-article-slug]')) {
    if (li.getBoundingClientRect().bottom > 0) return li;
  }
  return null;
}

function rowFor(list: HTMLElement, slug: string): HTMLElement | null {
  for (const li of list.querySelectorAll<HTMLElement>('li[data-article-slug]')) {
    if (li.dataset.articleSlug === slug) return li;
  }
  return null;
}

function restoreAnchor(list: HTMLElement): void {
  const anchor = readAnchor(history.state);
  if (!anchor) return;
  const row = rowFor(list, anchor.slug);
  if (!row) return;
  history.scrollRestoration = 'manual';
  let userMoved = false;
  const stop = () => { userMoved = true; };
  for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) window.addEventListener(ev, stop, { once: true, passive: true });
  const align = () => {
    if (userMoved) return;
    // `instant`: the site sets `scroll-behavior: smooth`, which would animate down from the top instead.
    window.scrollTo({ top: window.scrollY + row.getBoundingClientRect().top - anchor.top, behavior: 'instant' });
  };
  align();
  // Web fonts (display=swap) and late layout can shift cards; realign until the reader takes over.
  void document.fonts?.ready.then(align);
  window.addEventListener('load', align, { once: true });
}

export function initArticleInfiniteList(): void {
  const list = document.querySelector<HTMLElement>('[data-article-list]');
  if (!list) return;
  const status = document.querySelector<HTMLElement>('[data-article-list-status]');
  let more = document.querySelector<HTMLAnchorElement>('[data-article-more]');
  let page = Number(list.dataset.page) || 1;
  let loading = false;
  let failed = false;
  let clicked = false;

  restoreAnchor(list);

  // Remember the card the reader opens (same-tab navigation goes through pagehide below).
  list.addEventListener('click', e => {
    const target = e.target instanceof Element ? e.target : null;
    const row = target?.closest<HTMLElement>('li[data-article-slug]');
    if (!row || !target?.closest('a[href]')) return;
    clicked = true;
    saveState({ articleListAnchor: { slug: row.dataset.articleSlug ?? '', top: row.getBoundingClientRect().top } });
  });
  window.addEventListener('pagehide', () => {
    if (clicked) return;
    const row = firstVisibleRow(list);
    if (row) saveState({ articleListAnchor: { slug: row.dataset.articleSlug ?? '', top: row.getBoundingClientRect().top } });
  });
  window.addEventListener('pageshow', e => { if (e.persisted) clicked = false; });

  if (!more) return;

  const setLabel = (key: 'label' | 'loading' | 'failed') => {
    if (!more) return;
    more.textContent = more.dataset[key] ?? more.textContent;
    if (key === 'loading') more.setAttribute('aria-busy', 'true');
    else more.removeAttribute('aria-busy');
  };

  const near = () => Boolean(more && more.getBoundingClientRect().top < window.innerHeight + LOAD_AHEAD_PX);

  const loadNext = async (): Promise<void> => {
    if (!more || loading) return;
    loading = true;
    failed = false;
    setLabel('loading');
    const next = page + 1;
    try {
      const res = await fetch(more.dataset.partial ?? '', { credentials: 'same-origin', headers: { Accept: 'text/html' } });
      if (!res.ok) throw new Error(`http_${res.status}`);
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const chunk = doc.querySelector<HTMLElement>('[data-article-page]');
      if (!chunk) throw new Error('bad_partial');
      const rows = [...chunk.querySelectorAll<HTMLElement>(':scope > li[data-article-slug]')];
      // Skip rows already shown (a publish between two fetches can shift the window by one).
      const seen = new Set([...list.querySelectorAll<HTMLElement>('li[data-article-slug]')].map(li => li.dataset.articleSlug));
      list.append(...rows.filter(li => !seen.has(li.dataset.articleSlug)).map(li => document.adoptNode(li)));
      page = next;
      list.dataset.page = String(page);
      saveState({}, listPageUrl(location.href, page));
      if (status) status.textContent = more.dataset.loaded?.replace('{n}', String(rows.length)) ?? '';
      if (chunk.dataset.hasMore !== 'true') {
        observer.disconnect();
        more.parentElement?.remove();
        more = null;
        return;
      }
      more.href = listPageUrl(location.href, page + 1);
      more.dataset.partial = partialPageUrl(more.dataset.partial ?? '', page + 1);
      setLabel('label');
    } catch {
      failed = true;
      setLabel('failed');
    } finally {
      loading = false;
    }
    // A short page can leave the link inside the look-ahead zone, where the observer will not fire again.
    if (!failed && near()) void loadNext();
  };

  const observer = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting) && !failed) void loadNext();
  }, { rootMargin: `0px 0px ${LOAD_AHEAD_PX}px 0px` });
  observer.observe(more);

  // The link is a real ?page=N+1 link (no-JS, crawlers); with JS it loads in place, and retries after a failure.
  more.addEventListener('click', e => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    void loadNext();
  });
}
