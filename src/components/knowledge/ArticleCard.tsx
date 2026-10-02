import type { DiscoveryItem } from '../../lib/blocks/discovery';
import type { Locale } from '../../lib/i18n/locales';
import { articlePath } from '../../lib/blocks/seo';
import { BrandedThumbnail } from './BrandedThumbnail';
import { EntitlementIcon } from './EntitlementIcon';
import { TagBadges } from './TagBadges';
import { formatKnowledgeDate, knowledgeStrings } from './strings';

/** Fields a list row needs (REST list items satisfy this). */
export type CardArticle = Pick<
  DiscoveryItem,
  'slug' | 'locale' | 'title' | 'excerpt' | 'topic_tags' | 'labels' | 'category' | 'access' | 'published_at' | 'reading_minutes' | 'cover_url' | 'snippet'
>;

interface Props {
  article: CardArticle;
  /** UI locale (the article's own locale decides its link). */
  uiLocale: Locale;
  compact?: boolean;
  headingLevel?: 2 | 3;
}

/** Renders a `**match**` search snippet safely (React escapes text; only <mark> is added). */
function Snippet({ text }: { text: string }) {
  const parts = text.split('**');
  return <>{parts.map((p, i) => (i % 2 === 1 ? <mark key={i} className="bg-amber-100 text-inherit rounded px-0.5">{p}</mark> : <span key={i}>{p}</span>))}</>;
}

export function ArticleCard({ article: a, uiLocale, compact = false, headingLevel = 2 }: Props) {
  const t = knowledgeStrings(uiLocale);
  const H = headingLevel === 2 ? 'h2' : 'h3';
  const href = articlePath(a.slug, a.locale);
  const meta = [a.category?.name, a.reading_minutes > 0 ? t.minutes(a.reading_minutes) : null, compact ? null : formatKnowledgeDate(a.published_at, uiLocale)]
    .filter(Boolean).join(' · ');
  return (
    <article className={`relative flex gap-3 ${compact ? 'p-2.5' : 'p-3 sm:p-4'} rounded-2xl bg-white/70 border border-stone-200 hover:bg-white hover:shadow-card-hover transition-all focus-within:ring-2 focus-within:ring-amber-600`}>
      <BrandedThumbnail seed={a.slug} coverUrl={a.cover_url} width={compact ? 56 : 80} height={compact ? 64 : 92} />
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2 text-[11px] font-bold uppercase tracking-wider text-stone-500">
          <span className="truncate">{meta}</span>
          <EntitlementIcon access={a.access} paidLabel={t.paidAria} freeLabel={t.freeAria} />
        </div>
        <H className={`font-serif ${compact ? 'text-base' : 'text-lg sm:text-xl'} font-bold text-stone-900 leading-snug break-words`}>
          {/* The whole card is clickable through this link's ::after overlay; tag links stay above it. */}
          <a href={href} hrefLang={a.locale} className="after:absolute after:inset-0 after:rounded-2xl focus:outline-none">{a.title}</a>
        </H>
        {!compact && a.snippet && <p className="text-sm text-stone-600 line-clamp-2"><Snippet text={a.snippet} /></p>}
        {!compact && !a.snippet && a.excerpt && <p className="text-sm text-stone-600 line-clamp-2">{a.excerpt}</p>}
        <div className="relative z-10 mt-0.5">
          <TagBadges tags={a.topic_tags} labels={compact ? [] : a.labels} linkBase="/articles" max={compact ? 3 : 6} size="sm" />
        </div>
      </div>
    </article>
  );
}

export default ArticleCard;
