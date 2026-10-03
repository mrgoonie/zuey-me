import type { PublicTag } from '../../lib/taxonomy/tags';
import type { PublicLabel } from '../../lib/taxonomy/labels';

interface Props {
  tags: PublicTag[];
  labels?: PublicLabel[];
  /** Link tags/labels to the discovery filter (`/articles?tag=` / `?label=`). */
  linkBase?: string;
  /** Extra query (e.g. `lang=en`) appended to filter links. */
  query?: string;
  max?: number;
  size?: 'sm' | 'md';
}

const tagStyle = (size: 'sm' | 'md') =>
  `inline-flex items-center rounded-full border border-stone-200 bg-white/70 text-stone-600 ${size === 'sm' ? 'px-2 py-0.5 text-[10.5px]' : 'px-2.5 py-1 text-[11.5px]'} font-semibold`;
const labelStyle = (size: 'sm' | 'md') =>
  `inline-flex items-center rounded-full bg-amber-50 border border-amber-200 text-amber-900 ${size === 'sm' ? 'px-2 py-0.5 text-[10.5px]' : 'px-2.5 py-1 text-[11.5px]'} font-semibold`;

function href(base: string, key: string, value: string, query?: string): string {
  return `${base}?${key}=${encodeURIComponent(value)}${query ? `&${query}` : ''}`;
}

/** Public topic tags (and approved labels) — shown to every reader, including free and anonymous ones. */
export function TagBadges({ tags, labels = [], linkBase, query, max, size = 'md' }: Props) {
  const shownTags = max === undefined ? tags : tags.slice(0, max);
  if (shownTags.length === 0 && labels.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5 list-none p-0 m-0">
      {labels.map(l => (
        <li key={l.id}>
          {linkBase
            ? <a className={labelStyle(size)} href={href(linkBase, 'label', `${l.kind}:${l.slug}`, query)}>{l.name}{l.version ? ` ${l.version}` : ''}</a>
            : <span className={labelStyle(size)}>{l.name}{l.version ? ` ${l.version}` : ''}</span>}
        </li>
      ))}
      {shownTags.map(t => (
        <li key={t.id}>
          {linkBase
            ? <a className={tagStyle(size)} href={href(linkBase, 'tag', t.slug, query)}>#{t.name}</a>
            : <span className={tagStyle(size)}>#{t.name}</span>}
        </li>
      ))}
    </ul>
  );
}

export default TagBadges;
