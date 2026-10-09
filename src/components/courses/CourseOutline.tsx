import type { CourseDetail } from '../../lib/courses/course-views';
import { fmtMinutes } from './course-ui';

type Section = CourseDetail['outline'][number];

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/**
 * Course outline: sections with lessons, lock icons on lessons the viewer cannot open, "Học thử"
 * badges on trial lessons and check marks on completed ones. Static markup (no hydration needed).
 */
export function CourseOutline({ courseSlug, sections, completedIds = [], currentLessonId, compact = false }: {
  courseSlug: string;
  sections: Section[];
  completedIds?: string[];
  currentLessonId?: string;
  compact?: boolean;
}) {
  const done = new Set(completedIds);
  if (sections.every(s => s.lessons.length === 0)) {
    return <p className="text-sm text-stone-600">Nội dung khoá học đang được cập nhật.</p>;
  }
  return (
    <ol className={`grid ${compact ? 'gap-3' : 'gap-5'} min-w-0`}>
      {sections.map((s, si) => (
        <li key={s.id} className="min-w-0">
          <h3 className={`${compact ? 'text-xs uppercase tracking-wider text-stone-500' : 'text-base font-serif'} font-bold break-words`}>
            {compact ? s.title : `Phần ${si + 1}. ${s.title}`}
          </h3>
          {!compact && s.summary && <p className="mt-0.5 text-sm text-stone-600">{s.summary}</p>}
          <ul className={`${compact ? 'mt-1' : 'mt-2'} grid gap-1`}>
            {s.lessons.map(l => {
              const current = l.id === currentLessonId;
              const completed = done.has(l.id);
              const label = `${l.title}${l.is_trial ? ' (học thử)' : ''}${l.locked ? ' (đã khoá)' : ''}${completed ? ' (đã hoàn thành)' : ''}`;
              return (
                <li key={l.id} className="min-w-0">
                  <a
                    href={`/courses/${courseSlug}/${l.slug}`}
                    aria-current={current ? 'page' : undefined}
                    aria-label={label}
                    className={`flex min-h-[44px] items-center gap-2 rounded-xl px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                      current ? 'bg-stone-900 text-amber-50' : 'hover:bg-white/80'
                    } ${l.locked && !current ? 'text-stone-500' : ''}`}
                  >
                    <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${completed ? 'bg-emerald-600 text-white' : current ? 'text-amber-300' : 'text-stone-400'}`}>
                      {completed ? <CheckIcon /> : l.locked ? <LockIcon /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                    </span>
                    <span className="min-w-0 flex-1 break-words">{l.title}</span>
                    {l.is_trial && <span className="shrink-0 rounded-full bg-emerald-100 border border-emerald-300 px-2 py-0.5 text-[10px] font-bold text-emerald-900">Học thử</span>}
                    {l.status !== 'published' && <span className="shrink-0 rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-bold text-stone-900">Nháp</span>}
                    {!compact && l.duration_minutes > 0 && <span className="shrink-0 text-xs tabular-nums opacity-70">{fmtMinutes(l.duration_minutes)}</span>}
                  </a>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}
