import React from 'react';
import type { Locale } from '../../lib/i18n/locales';
import { courseLink, LAB200_ORIGIN, LAB200_REF, splitFeatured, type Lab200Course } from '../../lib/lab200/courses';
import { LAB200_AUTHOR, lab200Copy } from '../../lib/lab200/copy';
import type { Lab200Snapshot } from '../../lib/lab200/store';
import { trackEvent } from '../../lib/posthog';

/** Where a click came from: the Zuey OS window, the /200lab page, or the "Duy's picks" section of either. */
type ClickSource = 'app' | 'route' | 'featured';

interface Lab200CoursesProps {
  snapshot: Lab200Snapshot;
  locale: Locale;
  variant: 'window' | 'page';
}

function formatTime(iso: string, locale: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-GB', {
    timeZone: 'Asia/Saigon', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

/** 16:9 thumbnail (200lab's og:image is 1280×720); a soft placeholder keeps the layout when it is missing. */
const CourseThumb: React.FC<{ image?: string | null; link: React.AnchorHTMLAttributes<HTMLAnchorElement>; className: string }> = ({
  image, link, className,
}) => (
  // Duplicate of the title link, so it is hidden from keyboard and screen readers.
  <a {...link} tabIndex={-1} aria-hidden="true" className={`block overflow-hidden rounded-xl bg-stone-200/70 aspect-video shrink-0 ${className}`}>
    {image && (
      <img src={image} alt="" loading="lazy" decoding="async" width={1280} height={720} className="w-full h-full object-cover" />
    )}
  </a>
);

const CourseCard: React.FC<{ course: Lab200Course; source: ClickSource; locale: Locale; highlight?: boolean }> = ({
  course, source, locale, highlight = false,
}) => {
  const t = lab200Copy(locale);
  const link = {
    href: courseLink(course.slug),
    target: '_blank',
    rel: 'sponsored noopener',
    onClick: () => trackEvent('200lab_course_click', { slug: course.slug, source }),
  };
  // Picks stack the image above the text; the full list puts a smaller image beside it when wide (`.lab200-row`).
  return (
    <li className={`rounded-2xl border p-4 min-w-0 ${highlight ? 'bg-amber-50/90 border-amber-200' : 'lab200-row bg-white/80 border-stone-200/90'}`}>
      <CourseThumb image={course.image} link={link} className="lab200-thumb mb-3" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-stone-500 mb-1.5">
          {course.lessons !== null && <span>{t.lessons(course.lessons)}</span>}
          {course.status && (
            <span className={`px-2 py-0.5 rounded-full font-semibold ${course.free ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-900 text-[#F5EFEB]'}`}>
              {course.free ? t.free : course.status.replace(/^Đang mở bán,\s*/i, '')}
            </span>
          )}
        </div>
        <a
          {...link}
          className="block font-serif text-lg font-bold leading-snug text-stone-900 hover:text-amber-700 break-words"
        >
          {course.title}
        </a>
        {course.summary && <p className="text-sm text-stone-700 mt-1.5 leading-relaxed break-words">{course.summary}</p>}
        <a
          {...link}
          className="inline-flex mt-3 text-xs font-semibold text-amber-800 hover:text-amber-950"
        >
          {t.view} →
        </a>
      </div>
    </li>
  );
};

/** 200lab app: Duy's intro, recommended courses and every open 200lab course, linked with the referral code. */
export const Lab200Courses: React.FC<Lab200CoursesProps> = ({ snapshot, locale, variant }) => {
  const t = lab200Copy(locale);
  const { featured, others } = splitFeatured(snapshot.courses);
  const source: ClickSource = variant === 'window' ? 'app' : 'route';

  return (
    <main className="relative w-full flex flex-col items-center justify-start py-3 sm:py-8 md:py-12 px-2.5 sm:px-4 md:px-6 z-10">
      <div className="w-full max-w-[720px] bg-[#F5EFEB] rounded-[28px] sm:rounded-[36px] md:rounded-[40px] border border-stone-200/90 shadow-floating-card px-3.5 py-6 sm:px-6 sm:py-8 md:p-8 flex flex-col min-w-0">
        <header className="mb-5 sm:mb-6">
          {variant === 'page' && <a href="/" className="text-xs font-semibold text-stone-500 hover:text-stone-900">{t.back}</a>}
          <h1 className="font-serif text-3xl sm:text-4xl font-black tracking-tight text-stone-900 mt-2">{t.title}</h1>
          <p className="text-sm text-stone-700 mt-2 leading-relaxed">{t.intro}</p>
          <p className="text-sm text-stone-700 mt-2 leading-relaxed">
            {t.author.before}<strong className="font-semibold text-stone-900">{LAB200_AUTHOR.name}</strong>{t.author.after}
            <a href={LAB200_AUTHOR.companyUrl} target="_blank" rel="noopener" className="font-semibold text-amber-800 hover:text-amber-950 underline underline-offset-2">
              {LAB200_AUTHOR.company}
            </a>.
          </p>
          <p className="inline-flex mt-3 text-xs font-bold text-amber-900 bg-amber-100/80 border border-amber-200 rounded-full px-3 py-1.5">
            🏷 {t.discount}
          </p>
        </header>

        {snapshot.courses.length === 0 ? (
          <div className="text-center py-10 text-sm text-stone-600 flex flex-col items-center gap-3">
            <p>{t.empty}</p>
            <a
              href={`${LAB200_ORIGIN}/?ref=${LAB200_REF}`}
              target="_blank"
              rel="sponsored noopener"
              className="px-4 py-2 rounded-full bg-stone-900 text-[#F5EFEB] text-xs font-semibold hover:bg-stone-700"
            >
              {t.openSite} →
            </a>
          </div>
        ) : (
          <>
            {featured.length > 0 && (
              <section className="mb-6" aria-label={t.featured}>
                <h2 className="text-[11px] font-bold uppercase tracking-wider text-stone-500 mb-2.5">★ {t.featured}</h2>
                <ul className="grid gap-3 sm:grid-cols-2">
                  {featured.map(c => <CourseCard key={c.slug} course={c} source="featured" locale={locale} highlight />)}
                </ul>
              </section>
            )}
            {others.length > 0 && (
              <section aria-label={t.all}>
                <h2 className="text-[11px] font-bold uppercase tracking-wider text-stone-500 mb-2.5">
                  {t.all} ({snapshot.courses.length})
                </h2>
                <ul className="lab200-list flex flex-col gap-3">
                  {others.map(c => <CourseCard key={c.slug} course={c} source={source} locale={locale} />)}
                </ul>
              </section>
            )}
          </>
        )}

        <footer className="mt-6 flex flex-wrap items-center justify-between gap-2 text-[11px] text-stone-500">
          <span>
            {snapshot.syncedAt ? `${t.updated(formatTime(snapshot.syncedAt, locale))} · ` : ''}
            {t.disclosure}
          </span>
          <a href="/200lab.md" className="font-semibold hover:text-stone-900">200lab.md</a>
        </footer>
      </div>
    </main>
  );
};
