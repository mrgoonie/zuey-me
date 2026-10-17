import type { ArticleSummary } from './articles';
import type { Locale } from '../i18n/locales';

export type WriteOperation = 'create' | 'update' | 'publish' | 'tags_set' | 'edition_delete';

/**
 * Compact outcome of a writer call. `status` on the summary describes the article shown in the
 * response, which may be the public edition; the receipt states what the operation itself did and
 * what readers see now, so an agent never infers a failure from an unchanged `status`.
 */
export interface OperationReceipt {
  operation_success: true;
  operation: WriteOperation;
  article_revision: number;
  /** Edition the operation touched (the edition shown in the response). */
  edition_locale: Locale;
  /** Revision of the public version of that edition; null when it was never published. */
  published_revision: number | null;
  /** True when the edition's draft differs from what readers see. */
  has_unpublished_changes: boolean;
  /** What readers get for that edition right now. */
  public_status: 'published' | 'unpublished';
  changed_fields: string[];
  next_action: string;
}

const CHANGEABLE = ['slug', 'title', 'excerpt', 'access', 'category', 'tags', 'document', 'locale', 'primary_locale'] as const;

/** Names of the input fields an update actually carried. */
export function changedFields(input: object): string[] {
  const present = input as Record<string, unknown>;
  return CHANGEABLE.filter(key => present[key] !== undefined);
}

export function buildReceipt(
  operation: WriteOperation,
  summary: Pick<ArticleSummary, 'revision' | 'locale' | 'published_revision' | 'has_unpublished_changes' | 'slug'>,
  changed: string[] = [],
): OperationReceipt {
  const published = summary.published_revision !== null;
  let next: string;
  if (operation === 'edition_delete') next = 'none';
  else if (!published) next = 'article_publish to make this edition public';
  else if (summary.has_unpublished_changes) next = 'article_publish to release the draft; readers still see published_revision';
  else next = 'none';
  return {
    operation_success: true,
    operation,
    article_revision: summary.revision,
    edition_locale: summary.locale,
    published_revision: summary.published_revision,
    has_unpublished_changes: summary.has_unpublished_changes,
    public_status: published ? 'published' : 'unpublished',
    changed_fields: changed,
    next_action: next,
  };
}
