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
  /**
   * Keep the badges on one row and clip the rest (faded at the edge). List cards use it so their height does
   * not depend on how many badges fit per row, which changes when the web font replaces the fallback.
   */
  singleLine?: boolean;
}

const tagStyle = (size: 'sm' | 'md') =>
  `inline-flex items-center rounded-full border border-stone-200 bg-white/70 text-stone-600 ${size === 'sm' ? 'px-2 py-0.5 text-[10.5px]' : 'px-2.5 py-1 text-[11.5px]'} font-semibold`;
const labelStyle = (size: 'sm' | 'md') =>
  `inline-flex items-center rounded-full bg-amber-50 border border-amber-200 text-amber-900 ${size === 'sm' ? 'px-2 py-0.5 text-[10.5px]' : 'px-2.5 py-1 text-[11.5px]'} font-semibold`;

function href(base: string, key: string, value: string, query?: string): string {
  return `${base}?${key}=${encodeURIComponent(value)}${query ? `&${query}` : ''}`;
}

/**
 * One row of badges: `overflow: clip` (unlike `hidden`) cannot be scrolled, so focusing a clipped badge never leaves
 * the row shifted; each `li` is a flex box so the row is exactly one pill tall in any font. While a badge has keyboard
 * focus the row wraps and drops the clip and fade, so the focused badge and its focus ring are fully visible (a shift
 * right after user input does not count as layout shift).
 */
const SINGLE_LINE = [
  'flex-nowrap overflow-clip whitespace-nowrap [&>li]:flex [&>li]:flex-none',
  '[mask-image:linear-gradient(to_right,#000_calc(100%-24px),transparent)]',
  'has-[:focus-visible]:flex-wrap has-[:focus-visible]:overflow-visible has-[:focus-visible]:[mask-image:none]',
].join(' ');

/** Public topic tags (and approved labels) — shown to every reader, including free and anonymous ones. */
export function TagBadges({ tags, labels = [], linkBase, query, max, size = 'md', singleLine = false }: Props) {
  const shownTags = max === undefined ? tags : tags.slice(0, max);
  if (shownTags.length === 0 && labels.length === 0) return null;
  return (
    <ul
      className={`flex gap-1.5 list-none p-0 m-0 ${singleLine ? SINGLE_LINE : 'flex-wrap'}`}
      title={singleLine ? [...labels.map(l => l.name), ...shownTags.map(t => `#${t.name}`)].join(', ') : undefined}
    >
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
