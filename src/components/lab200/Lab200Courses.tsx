import React from 'react';
import type { Locale } from '../../lib/i18n/locales';
import {
  courseLink, coursePrice, formatVnd, LAB200_ORIGIN, LAB200_REF, LAB200_REF_DISCOUNT, splitFeatured, type Lab200Course,
} from '../../lib/lab200/courses';
import { LAB200_AUTHOR, lab200Copy } from '../../lib/lab200/copy';
import type { Lab200Snapshot } from '../../lib/lab200/store';
import { trackEvent } from '../../lib/posthog';
import './lab200.css';

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

const CourseCard: React.FC<{ course: Lab200Course; source: ClickSource; locale: Locale; index: number }> = ({
  course, source, locale, index,
}) => {
  const t = lab200Copy(locale);
  const price = course.free ? null : coursePrice(course.status);
  const link = {
    href: courseLink(course.slug),
    target: '_blank',
    rel: 'sponsored noopener',
    onClick: () => trackEvent('200lab_course_click', { slug: course.slug, source }),
  };
  return (
    <li className="lab200-tile">
      {/* 16:9 thumbnail (200lab's og:image is 1280×720). It repeats the title link, so it is hidden from keyboard and screen readers. */}
      <a {...link} tabIndex={-1} aria-hidden="true" className="lab200-thumb">
        {course.image && <img src={course.image} alt="" loading="lazy" decoding="async" width={1280} height={720} />}
      </a>
      <div className="lab200-tile-body">
        <div className="lab200-meta">
          <span className="lab200-kicker">Fig. {String(index + 1).padStart(2, '0')}</span>
          {course.lessons !== null && <span className="lab200-kicker">{t.lessons(course.lessons)}</span>}
        </div>
        <a {...link} className="lab200-course-title">{course.title}</a>
        {course.summary && <p className="lab200-summary">{course.summary}</p>}
        <div className="lab200-buy">
          <div>
            {price ? (
              <>
                <div className="lab200-was">
                  <span>{t.basePrice}</span>
                  <s>{formatVnd(price.base)}</s>
                  <span className="lab200-chip">−{Math.round(LAB200_REF_DISCOUNT * 100)}%</span>
                </div>
                <div className="lab200-price">
                  {price.from && <small>{t.priceFrom}</small>}
                  <span>{formatVnd(price.discounted)}</span>
                  <small>{t.refPrice.toLowerCase()}</small>
                </div>
              </>
            ) : (
              <div className={`lab200-price${course.free ? ' lab200-price--free' : ''}`}>
                {course.free ? t.free : course.status.replace(/^Đang mở bán,\s*/i, '')}
              </div>
            )}
          </div>
          <a {...link} className="lab200-btn">{t.view} →</a>
        </div>
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
    <main className={`lab200 lab200--${variant}`}>
      <div className="lab200-shell">
        <header>
          {variant === 'page' && <a href="/" className="lab200-back">{t.back}</a>}
          <p className="lab200-kicker" style={{ marginTop: variant === 'page' ? 16 : 0 }}>
            <b>200Lab</b> · {t.kicker}
          </p>
          <h1 className="lab200-title">{t.heading}</h1>
          <p className="lab200-body">{t.intro}</p>
          <p className="lab200-body">
            {t.author.before}<strong>{LAB200_AUTHOR.name}</strong>{t.author.after}
            <a href={LAB200_AUTHOR.companyUrl} target="_blank" rel="noopener" className="lab200-link">{LAB200_AUTHOR.company}</a>.
          </p>
          <div className="lab200-offer">
            <span className="lab200-offer-badge" aria-hidden="true">−{Math.round(LAB200_REF_DISCOUNT * 100)}%</span>
            <div>
              <p className="lab200-offer-title">{t.discount}</p>
              <p className="lab200-offer-code">{t.code} <code>{LAB200_REF}</code></p>
            </div>
          </div>
        </header>

        {snapshot.courses.length === 0 ? (
          <div className="lab200-empty">
            <p>{t.empty}</p>
            <a href={`${LAB200_ORIGIN}/?ref=${LAB200_REF}`} target="_blank" rel="sponsored noopener" className="lab200-btn">
              {t.openSite} →
            </a>
          </div>
        ) : (
          <>
            {featured.length > 0 && (
              <section className="lab200-section" aria-label={t.featured}>
                <h2 className="lab200-h2">★ {t.featured}</h2>
                <ul className="lab200-grid">
                  {featured.map((c, i) => <CourseCard key={c.slug} course={c} source="featured" locale={locale} index={i} />)}
                </ul>
              </section>
            )}
            {others.length > 0 && (
              <section className="lab200-section" aria-label={t.all}>
                <h2 className="lab200-h2">{t.all} <small>{t.results(snapshot.courses.length)}</small></h2>
                <ul className="lab200-list">
                  {others.map((c, i) => (
                    <CourseCard key={c.slug} course={c} source={source} locale={locale} index={featured.length + i} />
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        <footer className="lab200-footer">
          <div>
            <p>
              {snapshot.syncedAt ? `${t.updated(formatTime(snapshot.syncedAt, locale))} · ` : ''}
              {t.disclosure}
            </p>
            {snapshot.courses.some(c => !c.free && coursePrice(c.status)) && <p>{t.priceNote}</p>}
          </div>
          <a href="/200lab.md">200lab.md</a>
        </footer>
      </div>
    </main>
  );
};
