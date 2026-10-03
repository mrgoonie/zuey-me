import type { D1DatabaseLike } from '../../db/store';
import { listArticles } from '../blocks/articles';
import type { Locale } from '../i18n/locales';
import { listCategories, toPublicCategory } from './categories';
import type { PublicCategory } from './categories';
import { labelKey, listLabels, toPublicLabel } from './labels';
import type { PublicLabel } from './labels';
import { listTags, toPublicTag } from './tags';
import type { PublicTag } from './tags';

export interface FacetCount { published_count: number }
export type PublicTagFacet = PublicTag & FacetCount;
export type PublicCategoryFacet = PublicCategory & FacetCount;
export type PublicLabelFacet = PublicLabel & FacetCount & { key: string };

export interface PublicTaxonomy {
  tags: PublicTagFacet[];
  categories: PublicCategoryFacet[];
  labels: PublicLabelFacet[];
}

/**
 * Public filter facets: only tags/categories/labels used by at least one published edition are listed,
 * with counts over published articles only (draft-only taxonomy never leaks to readers).
 */
export async function publicTaxonomy(d1: D1DatabaseLike | undefined, locale: Locale): Promise<PublicTaxonomy> {
  const articles = await listArticles(d1, { locale });
  const tagCounts = new Map<string, number>();
  const catCounts = new Map<string, number>();
  const labelCounts = new Map<string, number>();
  for (const a of articles) {
    for (const t of a.topic_tags) tagCounts.set(t.id, (tagCounts.get(t.id) ?? 0) + 1);
    if (a.category) catCounts.set(a.category.id, (catCounts.get(a.category.id) ?? 0) + 1);
    for (const l of a.labels) labelCounts.set(l.id, (labelCounts.get(l.id) ?? 0) + 1);
  }
  const tags = (await listTags(d1)).filter(t => tagCounts.has(t.id))
    .map(t => ({ ...toPublicTag(t, locale), published_count: tagCounts.get(t.id) ?? 0 }))
    .sort((a, b) => b.published_count - a.published_count || a.name.localeCompare(b.name, locale));
  const categories = (await listCategories(d1)).filter(c => catCounts.has(c.id))
    .map(c => ({ ...toPublicCategory(c, locale), published_count: catCounts.get(c.id) ?? 0 }));
  const labels = (await listLabels(d1)).filter(l => labelCounts.has(l.id))
    .map(l => ({ ...toPublicLabel(l, locale), key: labelKey(l), published_count: labelCounts.get(l.id) ?? 0 }));
  return { tags, categories, labels };
}
