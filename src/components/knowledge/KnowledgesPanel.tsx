import { useEffect, useId, useState } from 'react';
import type { Locale } from '../../lib/i18n/locales';
import type { PublicTaxonomy } from '../../lib/taxonomy/public';
import { ArticleCard } from './ArticleCard';
import type { CardArticle } from './ArticleCard';
import { knowledgeStrings } from './strings';

interface Filters { q: string; category: string; label: string; sort: 'new' | 'title' }
const EMPTY: Filters = { q: '', category: '', label: '', sort: 'new' };
const PANEL_LIMIT = 6;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Keeps only rows with the fields the card renders (defensive against an unexpected response). */
function toCards(data: unknown): CardArticle[] {
  if (!Array.isArray(data)) return [];
  return data.filter((a): a is CardArticle =>
    isObj(a) && typeof a.slug === 'string' && typeof a.title === 'string' && typeof a.locale === 'string' && Array.isArray(a.topic_tags));
}

function toTaxonomy(data: unknown): PublicTaxonomy | null {
  if (!isObj(data) || !Array.isArray(data.categories) || !Array.isArray(data.labels) || !Array.isArray(data.tags)) return null;
  const categories = data.categories.filter((c): c is PublicTaxonomy['categories'][number] => isObj(c) && typeof c.slug === 'string' && typeof c.name === 'string');
  const labels = data.labels.filter((l): l is PublicTaxonomy['labels'][number] => isObj(l) && typeof l.key === 'string' && typeof l.name === 'string');
  const tags = data.tags.filter((t): t is PublicTaxonomy['tags'][number] => isObj(t) && typeof t.slug === 'string' && typeof t.name === 'string');
  return { categories, labels, tags };
}

/**
 * Compact "Zuey's Knowledges" panel for the homepage right column: latest articles with entitlement
 * icons, public tags and thumbnails. Search and filters stay collapsed until the visitor opens them.
 */
export function KnowledgesPanel({ locale }: { locale: Locale }) {
  const t = knowledgeStrings(locale);
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [items, setItems] = useState<CardArticle[] | null>(null);
  const [error, setError] = useState(false);
  const [taxonomy, setTaxonomy] = useState<PublicTaxonomy | null>(null);
  const active = filters.q !== '' || filters.category !== '' || filters.label !== '' || filters.sort !== 'new';

  useEffect(() => {
    const ctrl = new AbortController();
    const params = new URLSearchParams({ lang: locale, limit: String(PANEL_LIMIT) });
    if (filters.q) params.set('q', filters.q);
    if (filters.category) params.set('category', filters.category);
    if (filters.label) params.set('label', filters.label);
    if (filters.sort !== 'new' || !filters.q) params.set('sort', filters.sort);
    setError(false);
    fetch(`/api/v1/articles?${params}`, { signal: ctrl.signal, credentials: 'same-origin' })
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: unknown) => {
        const body = isObj(data) && 'data' in data ? data.data : data;
        setItems(toCards(body).slice(0, PANEL_LIMIT));
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(true);
        setItems([]);
      });
    return () => ctrl.abort();
  }, [filters, locale]);

  useEffect(() => {
    if (!open || taxonomy) return;
    const ctrl = new AbortController();
    fetch(`/api/v1/taxonomy?lang=${locale}`, { signal: ctrl.signal })
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: unknown) => setTaxonomy(toTaxonomy(isObj(data) && 'data' in data ? data.data : data)))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [open, locale, taxonomy]);

  const apply = (next: Filters) => { setDraft(next); setFilters(next); };
  const browseHref = `/articles?lang=${locale}${filters.q ? `&q=${encodeURIComponent(filters.q)}` : ''}${filters.category ? `&category=${encodeURIComponent(filters.category)}` : ''}${filters.label ? `&label=${encodeURIComponent(filters.label)}` : ''}`;
  const chip = (pressed: boolean) =>
    `rounded-full border px-2.5 py-1 text-[11.5px] font-semibold ${pressed ? 'bg-stone-900 text-white border-stone-900' : 'bg-white/80 text-stone-700 border-stone-200 hover:bg-white'}`;

  return (
    <section aria-labelledby={`${ids}-title`} className="w-full min-w-0 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id={`${ids}-title`} className="font-serif text-lg font-extrabold text-stone-950">
          <a href={`/articles?lang=${locale}`} className="hover:underline">{t.sectionTitle}</a>
        </h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${ids}-filters`}
          onClick={() => setOpen(v => !v)}
          className="relative inline-flex items-center gap-1.5 rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs font-bold text-stone-800 hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-600"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" />
          </svg>
          {t.searchAndFilter}
          {active && <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-amber-600 ring-2 ring-white" aria-hidden="true" />}
        </button>
      </div>

      {open && (
        <form
          id={`${ids}-filters`}
          role="search"
          className="flex flex-col gap-2.5 rounded-2xl border border-stone-200 bg-white/70 p-3"
          onSubmit={e => { e.preventDefault(); apply({ ...draft, q: draft.q.trim() }); }}
        >
          <label className="sr-only" htmlFor={`${ids}-q`}>{t.searchLabel}</label>
          <div className="flex gap-2">
            <input
              id={`${ids}-q`} type="search" value={draft.q} maxLength={200} placeholder={t.searchPlaceholder}
              onChange={e => setDraft({ ...draft, q: e.target.value })}
              className="min-w-0 flex-1 rounded-full border border-stone-300 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-600"
            />
            <button type="submit" className="rounded-full bg-stone-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-stone-800">{t.apply}</button>
          </div>
          {taxonomy && taxonomy.categories.length > 0 && (
            <div role="group" aria-label={t.category} className="flex flex-wrap gap-1.5">
              <button type="button" aria-pressed={filters.category === ''} className={chip(filters.category === '')} onClick={() => apply({ ...draft, category: '' })}>{t.all}</button>
              {taxonomy.categories.map(c => (
                <button key={c.id} type="button" aria-pressed={filters.category === c.slug} className={chip(filters.category === c.slug)}
                  onClick={() => apply({ ...draft, category: filters.category === c.slug ? '' : c.slug })}>{c.name}</button>
              ))}
            </div>
          )}
          {taxonomy && taxonomy.labels.length > 0 && (
            <details className="text-sm" open={filters.label !== ''}>
              <summary className="cursor-pointer text-xs font-bold text-stone-700">{t.labelsAndFreshness}</summary>
              <label className="sr-only" htmlFor={`${ids}-label`}>{t.labelsAndFreshness}</label>
              <select
                id={`${ids}-label`} value={draft.label} onChange={e => apply({ ...draft, label: e.target.value })}
                className="mt-2 w-full rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm"
              >
                <option value="">{t.anyLabel}</option>
                {taxonomy.labels.map(l => <option key={l.id} value={l.key}>{l.name} ({l.published_count})</option>)}
              </select>
            </details>
          )}
          <div className="flex items-center justify-between gap-2">
            <div role="group" aria-label={t.sort} className="flex gap-1.5">
              <button type="button" aria-pressed={filters.sort === 'new'} className={chip(filters.sort === 'new')} onClick={() => apply({ ...draft, sort: 'new' })}>{t.sortNew}</button>
              <button type="button" aria-pressed={filters.sort === 'title'} className={chip(filters.sort === 'title')} onClick={() => apply({ ...draft, sort: 'title' })}>{t.sortTitle}</button>
            </div>
            {active && <button type="button" className="text-xs font-bold text-stone-600 underline hover:text-stone-900" onClick={() => apply(EMPTY)}>{t.reset}</button>}
          </div>
        </form>
      )}

      <div aria-live="polite" aria-busy={items === null}>
        {items === null && <p className="text-sm text-stone-500">{t.loading}</p>}
        {items !== null && error && <p className="text-sm text-stone-500">{t.loadFailed}</p>}
        {items !== null && !error && items.length === 0 && (
          <p className="text-sm text-stone-500">{active ? t.noResults : t.noArticles}</p>
        )}
        {items !== null && items.length > 0 && (
          <ul className="flex flex-col gap-2 list-none p-0 m-0">
            {items.map(a => <li key={`${a.slug}-${a.locale}`}><ArticleCard article={a} uiLocale={locale} compact headingLevel={3} /></li>)}
          </ul>
        )}
      </div>
      <a href={browseHref} className="self-start text-xs font-bold text-stone-700 underline hover:text-stone-950">{t.viewAll} →</a>
    </section>
  );
}

export default KnowledgesPanel;
