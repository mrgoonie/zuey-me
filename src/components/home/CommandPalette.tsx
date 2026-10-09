import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowLeft, BookOpen, Briefcase, CreditCard, FileCode2, FileText, KeyRound, LogIn, MessageCircle,
  Plug, Search, Shield, SquarePlay, User, X,
} from 'lucide-react';
import type { Locale } from '../../lib/i18n/locales';
import type { HomeStrings } from './home-i18n';
import { fmt } from './home-i18n';
import type { ArticleHit } from './api-client';
import { apiFetch, parseArticleHits } from './api-client';
import { animateDialogIn } from './motion';
import type { VideoHit } from '../../lib/videos/types';
import { parseVideoHits } from '../zueytube/zueytube-api-client';
import { STORAGE_KEYS, isRecord, readStored, writeStored } from './storage';
import { trackEvent } from '../../lib/posthog';

export type PaletteActionId = keyof HomeStrings['palette']['items'];

interface PaletteProps {
  open: boolean;
  onClose: () => void;
  strings: HomeStrings['palette'];
  locale: Locale;
  onOpenMcp: () => void;
  onShowActivity: () => void;
  /** Actions handled in place (e.g. open a Zuey OS window) instead of navigating to their page. */
  actionOverrides?: Partial<Record<PaletteActionId, () => void>>;
  /** Opens a Zueytube video in place (Zuey OS window); defaults to navigating to /videos?v=. */
  onOpenVideo?: (youtubeId: string) => void;
}

interface Option {
  key: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  group: 'recent' | 'actions' | 'articles' | 'videos';
  run: () => void;
}

interface RecentEntry { id: string; label: string; href: string | null }

const MAX_RECENT = 5;
const ACTION_ORDER: PaletteActionId[] = ['chat', 'search', 'mcp', 'pricing', 'subscribe', 'account', 'activity', 'docs', 'keys', 'privacy', 'business'];
const ACTION_HREF: Partial<Record<PaletteActionId, string>> = {
  chat: '/chat', pricing: '/pricing', subscribe: '/login?next=%2Fpricing', account: '/account', docs: '/docs',
  keys: '/account#keys', privacy: '/privacy', business: '/business',
};
const ACTION_ICON: Record<PaletteActionId, Option['icon']> = {
  chat: MessageCircle, search: Search, mcp: Plug, pricing: CreditCard, subscribe: LogIn, account: User,
  activity: Activity, docs: FileCode2, keys: KeyRound, privacy: Shield, business: Briefcase,
};
const isActionId = (v: string): v is PaletteActionId => (ACTION_ORDER as string[]).includes(v);

function readRecent(): RecentEntry[] {
  const raw = readStored(STORAGE_KEYS.recentCommands);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(r => {
    if (!isRecord(r) || typeof r.id !== 'string' || typeof r.label !== 'string') return [];
    const href = typeof r.href === 'string' && r.href.startsWith('/') && !r.href.startsWith('//') ? r.href : null;
    return [{ id: r.id.slice(0, 200), label: r.label.slice(0, 200), href }];
  }).slice(0, MAX_RECENT);
}

function normalize(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function matches(hit: ArticleHit, q: string): boolean {
  const needle = normalize(q);
  return [hit.title, hit.excerpt, ...hit.tags].some(v => normalize(v).includes(needle));
}

/**
 * Ctrl/⌘ K command palette: combobox + listbox with active-descendant navigation, recent items,
 * article search and site actions. Uses a modal <dialog> for the focus trap and Escape handling.
 */
export const CommandPalette: React.FC<PaletteProps> = ({ open, onClose, strings, locale, onOpenMcp, onShowActivity, actionOverrides, onOpenVideo }) => {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const cacheRef = useRef(new Map<string, ArticleHit[]>());
  const afterCloseRef = useRef<(() => void) | null>(null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'all' | 'articles'>('all');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [articles, setArticles] = useState<{ state: 'idle' | 'loading' | 'done' | 'error'; hits: ArticleHit[] }>({ state: 'idle', hits: [] });
  const videoCacheRef = useRef(new Map<string, VideoHit[]>());
  const [videos, setVideos] = useState<VideoHit[]>([]);
  const listId = useId();
  const titleId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const close = useCallback((after?: () => void) => {
    afterCloseRef.current = after ?? null;
    ref.current?.close();
  }, []);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setRecent(readRecent());
      setQuery('');
      setMode('all');
      setActive(0);
      dialog.showModal();
      inputRef.current?.focus();
      void animateDialogIn(dialog);
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onClosed = () => {
      onClose();
      const after = afterCloseRef.current;
      afterCloseRef.current = null;
      if (after) after();
      else if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
    dialog.addEventListener('close', onClosed);
    return () => dialog.removeEventListener('close', onClosed);
  }, [onClose]);

  // Article search: debounced, cached per query, filtered client-side by title/excerpt/tags.
  const q = query.trim();
  const wantsArticles = mode === 'articles' || q.length >= 2;
  useEffect(() => {
    if (!open || !wantsArticles || q.length === 0) {
      setArticles({ state: 'idle', hits: [] });
      return;
    }
    const key = `${locale}:${q}`;
    const cached = cacheRef.current.get(key);
    if (cached) {
      setArticles({ state: 'done', hits: cached });
      return;
    }
    setArticles(prev => ({ state: 'loading', hits: prev.hits }));
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const res = await apiFetch(`/api/v1/articles?q=${encodeURIComponent(q)}&locale=${locale}`, parseArticleHits);
      if (cancelled) return;
      if (!res.ok) {
        setArticles({ state: 'error', hits: [] });
        return;
      }
      const hits = res.data.filter(h => matches(h, q)).slice(0, 8);
      cacheRef.current.set(key, hits);
      setArticles({ state: 'done', hits });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, wantsArticles, q, locale]);

  // Video search (titles, descriptions and transcripts) runs alongside; failures just show no videos.
  useEffect(() => {
    if (!open || q.length < 2) {
      setVideos([]);
      return;
    }
    const key = `${locale}:${q}`;
    const cached = videoCacheRef.current.get(key);
    if (cached) {
      setVideos(cached);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const res = await apiFetch(`/api/v1/videos?q=${encodeURIComponent(q)}&locale=${locale}&limit=4`, parseVideoHits);
      if (cancelled) return;
      const hits = res.ok ? res.data : [];
      videoCacheRef.current.set(key, hits);
      setVideos(hits);
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, q, locale]);

  const remember = useCallback((entry: RecentEntry) => {
    const next = [entry, ...readRecent().filter(r => r.id !== entry.id)].slice(0, MAX_RECENT);
    writeStored(STORAGE_KEYS.recentCommands, next);
  }, []);

  const runAction = useCallback((id: PaletteActionId) => {
    trackEvent('command_palette_action', { action: id });
    if (id === 'search') {
      setMode('articles');
      setQuery('');
      setActive(0);
      inputRef.current?.focus();
      return;
    }
    remember({ id, label: strings.items[id], href: ACTION_HREF[id] ?? null });
    if (id === 'mcp') return close(onOpenMcp);
    if (id === 'activity') return close(onShowActivity);
    const override = actionOverrides?.[id];
    if (override) return close(override);
    const href = ACTION_HREF[id];
    if (href) close(() => window.location.assign(href));
  }, [actionOverrides, close, onOpenMcp, onShowActivity, remember, strings.items]);

  const openArticle = useCallback((hit: ArticleHit) => {
    const href = `/articles/${encodeURIComponent(hit.slug)}`;
    remember({ id: `article:${hit.slug}`, label: hit.title, href });
    trackEvent('command_palette_article', { slug: hit.slug });
    close(() => window.location.assign(href));
  }, [close, remember]);

  const openVideo = useCallback((hit: VideoHit) => {
    const href = `/videos?v=${encodeURIComponent(hit.youtube_id)}`;
    remember({ id: `video:${hit.youtube_id}`, label: hit.title, href });
    trackEvent('command_palette_video', { youtube_id: hit.youtube_id });
    close(() => (onOpenVideo ? onOpenVideo(hit.youtube_id) : window.location.assign(href)));
  }, [close, remember, onOpenVideo]);

  const options = useMemo<Option[]>(() => {
    const out: Option[] = [];
    const needle = normalize(q);
    if (mode === 'all') {
      if (!q) {
        for (const r of recent) {
          const actionId = isActionId(r.id) ? r.id : null;
          out.push({
            key: `recent:${r.id}`,
            label: actionId ? strings.items[actionId] : r.label,
            icon: actionId ? ACTION_ICON[actionId] : FileText,
            group: 'recent',
            run: () => {
              if (actionId) runAction(actionId);
              else if (r.href) {
                remember(r);
                close(() => window.location.assign(r.href ?? '/'));
              }
            },
          });
        }
      }
      for (const id of ACTION_ORDER) {
        const label = strings.items[id];
        if (needle && !normalize(label).includes(needle) && !id.includes(needle)) continue;
        out.push({ key: `action:${id}`, label, hint: ACTION_HREF[id], icon: ACTION_ICON[id], group: 'actions', run: () => runAction(id) });
      }
    }
    for (const hit of articles.hits) {
      out.push({ key: `article:${hit.slug}`, label: hit.title, hint: hit.excerpt, icon: BookOpen, group: 'articles', run: () => openArticle(hit) });
    }
    for (const hit of videos) {
      out.push({ key: `video:${hit.youtube_id}`, label: hit.title, hint: hit.snippet.replace(/\*\*/g, ''), icon: SquarePlay, group: 'videos', run: () => openVideo(hit) });
    }
    return out;
  }, [mode, q, recent, strings.items, articles.hits, videos, runAction, openArticle, openVideo, remember, close]);

  useEffect(() => {
    setActive(i => Math.min(i, Math.max(0, options.length - 1)));
  }, [options.length]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  });

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (options.length === 0) return;
      setActive(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (e.key === 'Home' && options.length > 0 && e.ctrlKey) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End' && options.length > 0 && e.ctrlKey) {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      options[active]?.run();
    } else if (e.key === 'Escape' && mode === 'articles' && !query) {
      e.preventDefault();
      setMode('all');
    } else if (e.key === 'Backspace' && mode === 'articles' && !query) {
      setMode('all');
    }
  };

  const groups: { id: Option['group']; label: string }[] = [
    { id: 'recent', label: strings.recent },
    { id: 'actions', label: strings.actions },
    { id: 'articles', label: strings.articles },
    { id: 'videos', label: strings.videos },
  ];

  const articleStatus = wantsArticles && q
    ? articles.state === 'loading' ? strings.searching
      : articles.state === 'error' ? strings.searchFailed
        : articles.state === 'done' && articles.hits.length === 0 ? strings.noArticles : ''
    : '';

  let index = -1;
  return (
    <dialog
      ref={ref}
      className="home-dialog home-dialog--palette"
      aria-labelledby={titleId}
      onClick={e => { if (e.target === ref.current) close(); }}
    >
      <h2 id={titleId} className="sr-only">{strings.title}</h2>
      <div className="home-palette-input">
        {mode === 'articles' ? (
          <button type="button" className="home-icon-btn -ml-2" aria-label={strings.actions} onClick={() => { setMode('all'); inputRef.current?.focus(); }}>
            <ArrowLeft aria-hidden="true" className="w-5 h-5" />
          </button>
        ) : (
          <Search aria-hidden="true" className="w-5 h-5 text-stone-500 shrink-0" />
        )}
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={options.length > 0 ? optionId(active) : undefined}
          aria-label={mode === 'articles' ? strings.items.search : strings.placeholder}
          placeholder={mode === 'articles' ? strings.items.search : strings.placeholder}
          value={query}
          onChange={e => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
          maxLength={120}
        />
        <button type="button" className="home-icon-btn" aria-label={strings.close} onClick={() => close()}>
          <X aria-hidden="true" className="w-5 h-5" />
        </button>
      </div>
      <div id={listId} role="listbox" aria-label={strings.title} className="home-listbox">
        {groups.map(g => {
          const items = options.filter(o => o.group === g.id);
          if (items.length === 0) return null;
          const labelId = `${listId}-${g.id}`;
          return (
            <div key={g.id} role="group" aria-labelledby={labelId}>
              <div id={labelId} className="home-group-label" role="presentation">{g.label}</div>
              {items.map(o => {
                index += 1;
                const i = index;
                const Icon = o.icon;
                return (
                  <div
                    key={o.key}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    className="home-option"
                    onPointerMove={() => { if (i !== active) setActive(i); }}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => o.run()}
                  >
                    <Icon aria-hidden={true} className="w-[18px] h-[18px]" />
                    <span>
                      {o.label}
                      {o.hint && <small>{o.hint}</small>}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
        {options.length === 0 && !articleStatus && <p className="px-3 py-6 text-center text-sm text-stone-500">{strings.empty}</p>}
      </div>
      <div className="home-palette-foot">
        <span role="status" aria-live="polite">{articleStatus || fmt(strings.results, { n: options.length })}</span>
        <span aria-hidden="true" className="hidden sm:inline">{strings.hint}</span>
      </div>
    </dialog>
  );
};
