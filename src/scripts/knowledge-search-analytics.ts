/**
 * Engagement events for the server-rendered /articles search page. The page renders the search
 * outcome into `[data-knowledge-search]` (the query length, never the query), and filter chips carry
 * `data-knowledge-filter`/`data-knowledge-value` with the public slug they switch to.
 */
import { track, trackOnce } from '../lib/analytics/client';
import { filterValue } from '../lib/analytics/engagement';

type ChipFilter = 'category' | 'tag' | 'reset';

function chipFilter(value: string | undefined): ChipFilter | null {
  return value === 'category' || value === 'tag' || value === 'reset' ? value : null;
}

function count(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function initKnowledgeSearchAnalytics(doc: Document = document): void {
  const outcome = doc.querySelector<HTMLElement>('[data-knowledge-search]');
  if (!outcome) return;
  const queryLength = count(outcome.dataset.queryLength);
  if (outcome.dataset.failed === '1') {
    trackOnce('knowledge_search_failed', 'feature_error', { feature: 'knowledge_search', reason: 'load_failed' });
  } else if (queryLength > 0 && count(outcome.dataset.page) <= 1) {
    trackOnce('knowledge_search', 'knowledge_search', {
      surface: 'articles', query_length: queryLength, results: count(outcome.dataset.results), semantic: outcome.dataset.semantic === '1',
    });
  }

  doc.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-knowledge-filter]') : null;
    const filter = chipFilter(target?.dataset.knowledgeFilter);
    if (!target || !filter) return;
    track('knowledge_filter_applied', { surface: 'articles', filter, value: filter === 'reset' ? 'all' : filterValue(target.dataset.knowledgeValue) });
  });

  // Selects only take effect on submit: record the ones whose value changed from what the page rendered.
  doc.addEventListener('submit', event => {
    const form = event.target instanceof HTMLFormElement && event.target.matches('[data-knowledge-form]') ? event.target : null;
    if (!form) return;
    for (const select of Array.from(form.querySelectorAll<HTMLSelectElement>('select[data-knowledge-filter]'))) {
      const filter = select.dataset.knowledgeFilter;
      if ((filter !== 'label' && filter !== 'sort') || select.value === (select.dataset.initial ?? '')) continue;
      track('knowledge_filter_applied', { surface: 'articles', filter, value: filterValue(select.value) });
    }
  });
}
