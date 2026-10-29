import React, { useId, useRef, useState } from 'react';
import type { Locale } from '../../lib/i18n/locales';
import {
  formatVnd, lab200Link, lab200PriceView, LAB200_ORIGIN, LAB200_REF, splitFeatured,
  type Lab200Course, type Lab200Cover, type Lab200LearningPath, type Lab200Pricing,
} from '../../lib/lab200/catalog';
import { LAB200_AUTHOR, lab200Copy } from '../../lib/lab200/copy';
import type { Lab200Catalog as Lab200CatalogData, Lab200Feed } from '../../lib/lab200/store';
import { track } from '../../lib/analytics/client';
import './lab200.css';

/** Where a click came from: the Zuey OS window, the /200lab page, or the "Duy's picks" section of either. */
type ClickSource = 'app' | 'route' | 'featured';
type Tab = 'courses' | 'paths';
type Copy = ReturnType<typeof lab200Copy>;

interface Lab200CatalogProps {
  catalog: Lab200CatalogData;
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

/** 16:9 cover from 200lab's own variants; an absent or broken image leaves the placeholder background. */
const Cover: React.FC<{ cover: Lab200Cover | null; link: React.AnchorHTMLAttributes<HTMLAnchorElement> }> = ({ cover, link }) => {
  const small = cover?.variants[0]?.url ?? cover?.url;
  return (
    // It repeats the title link, so it is hidden from keyboard and screen readers.
    <a {...link} tabIndex={-1} aria-hidden="true" className="lab200-thumb">
      {cover && small && (
        <img
          src={small}
          srcSet={cover.variants.length ? cover.variants.map(v => `${v.url} ${v.width}w`).join(', ') : undefined}
          sizes="(min-width: 600px) 360px, 100vw"
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          width={1280}
          height={720}
        />
      )}
    </a>
  );
};

const Price: React.FC<{ pricing: Lab200Pricing; t: Copy }> = ({ pricing, t }) => {
  const view = lab200PriceView(pricing);
  if (view.kind === 'free') return <div className="lab200-price lab200-price--free">{t.free}</div>;
  if (view.kind === 'unavailable') return <div className="lab200-price lab200-price--off">{t.unavailable}</div>;
  if (view.kind === 'unknown') return <div className="lab200-price lab200-price--note">{t.priceOnSite}</div>;
  return (
    <>
      {view.compareAt !== null && (
        <div className="lab200-was">
          <span>{t.compareAt}</span>
          <s>{formatVnd(view.compareAt)}</s>
        </div>
      )}
      <div className="lab200-price">
        {view.from && <small>{t.priceFrom}</small>}
        <span>{formatVnd(view.amount)}</span>
      </div>
    </>
  );
};

interface CardProps {
  item: Lab200Course | Lab200LearningPath;
  meta: string[];
  view: string;
  event: '200lab_course_click' | '200lab_learning_path_click';
  source: ClickSource;
  index: number;
  t: Copy;
}

const Card: React.FC<CardProps> = ({ item, meta, view, event, source, index, t }) => {
  const off = item.pricing.state !== 'available';
  const link = {
    href: lab200Link(item.url),
    target: '_blank',
    rel: 'sponsored noopener',
    onClick: () => track(event, { slug: item.slug, source }),
  };
  return (
    <li className={`lab200-tile${off ? ' lab200-tile--off' : ''}`}>
      <Cover cover={item.cover} link={link} />
      <div className="lab200-tile-body">
        <div className="lab200-meta">
          <span className="lab200-kicker">Fig. {String(index + 1).padStart(2, '0')}</span>
          {meta.filter(Boolean).map(m => <span key={m} className="lab200-kicker">{m}</span>)}
        </div>
        <a {...link} className="lab200-course-title">{item.title}</a>
        {item.summary && <p className="lab200-summary">{item.summary}</p>}
        <div className="lab200-buy">
          <div><Price pricing={item.pricing} t={t} /></div>
          <a {...link} className={off ? 'lab200-btn lab200-btn--quiet' : 'lab200-btn'}>{off ? t.viewOnSite : view} →</a>
        </div>
      </div>
    </li>
  );
};

const Empty: React.FC<{ text: string; t: Copy }> = ({ text, t }) => (
  <div className="lab200-empty">
    <p>{text}</p>
    <a href={lab200Link(`${LAB200_ORIGIN}/`)} target="_blank" rel="sponsored noopener" className="lab200-btn">{t.openSite} →</a>
  </div>
);

function Updated<T>({ feed, locale, t }: { feed: Lab200Feed<T>; locale: Locale; t: Copy }) {
  return feed.syncedAt ? <p className="lab200-updated">{t.updated(formatTime(feed.syncedAt, locale))}</p> : null;
}

/** 200lab app: Duy's intro, then 200lab's courses and learning paths in two tabs, every link carrying the referral code. */
export const Lab200Catalog: React.FC<Lab200CatalogProps> = ({ catalog, locale, variant }) => {
  const t = lab200Copy(locale);
  const id = useId();
  const [tab, setTab] = useState<Tab>('courses');
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ courses: null, paths: null });
  const { courses, learningPaths } = catalog;
  const { featured, others } = splitFeatured(courses.items);
  const source: ClickSource = variant === 'window' ? 'app' : 'route';
  const tabs: Array<{ key: Tab; label: string; count: number }> = [
    { key: 'courses', label: t.coursesTab, count: courses.items.length },
    { key: 'paths', label: t.pathsTab, count: learningPaths.items.length },
  ];

  // Roving focus between the two tabs (WAI-ARIA tabs pattern, automatic activation).
  const onTabKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const keys: Record<string, Tab | undefined> = {
      ArrowRight: tab === 'courses' ? 'paths' : 'courses',
      ArrowLeft: tab === 'courses' ? 'paths' : 'courses',
      Home: 'courses',
      End: 'paths',
    };
    const next = keys[e.key];
    if (!next) return;
    e.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  const courseCard = (c: Lab200Course, src: ClickSource, i: number) => (
    <Card
      key={c.slug} item={c} index={i} t={t} source={src} event="200lab_course_click" view={t.viewCourse}
      meta={[c.category?.name ?? '', c.lessonCount !== null ? t.lessons(c.lessonCount) : '']}
    />
  );
  const showPriceNote = [...courses.items, ...learningPaths.items].some(i => lab200PriceView(i.pricing).kind === 'paid');

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
            <span className="lab200-offer-badge" aria-hidden="true">{t.offerBadge}</span>
            <div>
              <p className="lab200-offer-title">{t.discount}</p>
              <p className="lab200-offer-code">{t.code} <code>{LAB200_REF}</code></p>
            </div>
          </div>
        </header>

        <div className="lab200-tabs" role="tablist" aria-label={t.tabs}>
          {tabs.map(x => (
            <button
              key={x.key}
              ref={el => { tabRefs.current[x.key] = el; }}
              type="button"
              role="tab"
              id={`${id}-tab-${x.key}`}
              aria-selected={tab === x.key}
              aria-controls={`${id}-panel-${x.key}`}
              tabIndex={tab === x.key ? 0 : -1}
              className="lab200-tab"
              onClick={() => setTab(x.key)}
              onKeyDown={onTabKey}
            >
              {x.label} <span className="lab200-tab-count">({x.count})</span>
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`${id}-panel-courses`} aria-labelledby={`${id}-tab-courses`} hidden={tab !== 'courses'}>
          {courses.items.length === 0 ? <Empty text={t.emptyCourses} t={t} /> : (
            <>
              {featured.length > 0 && (
                <section className="lab200-section" aria-label={t.featured}>
                  <h2 className="lab200-h2">★ {t.featured}</h2>
                  <ul className="lab200-grid" lang={courses.locale ?? undefined}>{featured.map((c, i) => courseCard(c, 'featured', i))}</ul>
                </section>
              )}
              {others.length > 0 && (
                <section className="lab200-section" aria-label={t.allCourses}>
                  <h2 className="lab200-h2">{t.allCourses} <small>{t.courses(courses.items.length)}</small></h2>
                  <ul className="lab200-list" lang={courses.locale ?? undefined}>{others.map((c, i) => courseCard(c, source, featured.length + i))}</ul>
                </section>
              )}
            </>
          )}
          <Updated feed={courses} locale={locale} t={t} />
        </div>

        <div role="tabpanel" id={`${id}-panel-paths`} aria-labelledby={`${id}-tab-paths`} hidden={tab !== 'paths'}>
          {learningPaths.items.length === 0 ? <Empty text={t.emptyPaths} t={t} /> : (
            <section className="lab200-section" aria-label={t.allPaths}>
              <h2 className="lab200-h2">{t.allPaths} <small>{t.paths(learningPaths.items.length)}</small></h2>
              <ul className="lab200-grid" lang={learningPaths.locale ?? undefined}>
                {learningPaths.items.map((p, i) => (
                  <Card
                    key={p.slug} item={p} index={i} t={t} source={source} event="200lab_learning_path_click" view={t.viewPath}
                    meta={[p.courseCount !== null ? t.pathCourses(p.courseCount) : '']}
                  />
                ))}
              </ul>
            </section>
          )}
          <Updated feed={learningPaths} locale={locale} t={t} />
        </div>

        <footer className="lab200-footer">
          <div>
            <p>{t.disclosure}</p>
            {showPriceNote && <p>{t.priceNote}</p>}
          </div>
          <a href="/200lab.md">200lab.md</a>
        </footer>
      </div>
    </main>
  );
};
