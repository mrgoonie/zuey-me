import {
  formatVnd, lab200Link, lab200PriceView, LAB200_ORIGIN, LAB200_REF, splitFeatured,
  type Lab200Course, type Lab200LearningPath, type Lab200Pricing,
} from './catalog';
import { LAB200_AUTHOR, lab200Copy } from './copy';
import type { Lab200Catalog, Lab200Feed } from './store';

const vi = lab200Copy('vi');
const en = lab200Copy('en');

/**
 * Feed text is already one sanitized line; also neutralize the Markdown/HTML syntax it could carry:
 * no HTML, no inline or image links (brackets escaped), no code spans.
 */
function mdText(s: string): string {
  return s.replace(/[<>]/g, c => (c === '<' ? '‹' : '›')).replace(/\s+/g, ' ').trim().replace(/([\\[\]`])/g, '\\$1');
}

function priceText(pricing: Lab200Pricing): string {
  const view = lab200PriceView(pricing);
  switch (view.kind) {
    case 'free': return 'Miễn phí / Free';
    case 'unavailable': return 'Chưa mở bán / Not on sale';
    case 'unknown': return 'xem giá trên 200lab / see the price on 200lab';
    case 'paid': {
      const amount = `${view.from ? 'từ / from ' : ''}${formatVnd(view.amount)}`;
      return view.compareAt ? `giá 200lab ${amount} (giá so sánh ${formatVnd(view.compareAt)})` : `giá 200lab ${amount}`;
    }
  }
}

function line(title: string, url: string, summary: string, meta: string[]): string {
  const tail = meta.filter(Boolean).join(' · ');
  return `- [${mdText(title)}](${lab200Link(url)}): ${mdText(summary)}${tail ? ` · ${mdText(tail)}` : ''}`;
}

function courseLine(c: Lab200Course): string {
  return line(c.title, c.url, c.summary, [
    c.category?.name ?? '',
    c.lessonCount !== null ? `${c.lessonCount} bài học` : '',
    priceText(c.pricing),
  ]);
}

function pathLine(p: Lab200LearningPath): string {
  return line(p.title, p.url, p.summary, [p.courseCount !== null ? `${p.courseCount} khoá học` : '', priceText(p.pricing)]);
}

function synced<T>(feed: Lab200Feed<T>): string {
  return feed.syncedAt ? `Last synced: ${feed.syncedAt} · source locale: ${feed.locale ?? 'unknown'}\n\n` : '';
}

/** /200lab.md: the same courses and learning paths as the app, every link carrying the referral code once. */
export function renderLab200Markdown(catalog: Lab200Catalog): string {
  const author = (c: typeof vi) => `${c.author.before}${LAB200_AUTHOR.name}${c.author.after}[${LAB200_AUTHOR.company}](${LAB200_AUTHOR.companyUrl}).`;
  const home = lab200Link(`${LAB200_ORIGIN}/`);
  let md = '# 200lab — Khoá học Duy giới thiệu / Courses Duy recommends\n\n';
  md += `${vi.intro}\n\n${en.intro}\n\n${author(vi)}\n${author(en)}\n\n`;
  md += `> ${vi.discount} (ref \`${LAB200_REF}\`). ${vi.disclosure}\n> ${en.discount}. ${en.disclosure}\n>\n`;
  md += `> ${vi.priceNote}\n> ${en.priceNote}\n\n`;

  const { courses, learningPaths } = catalog;
  md += `## ${vi.coursesTab} / ${en.coursesTab} (${courses.items.length})\n\n`;
  md += `Source: ${LAB200_ORIGIN}/courses.json\n\n${synced(courses)}`;
  if (courses.items.length === 0) {
    md += `_${en.emptyCourses}_ ${home}\n\n`;
  } else {
    const { featured, others } = splitFeatured(courses.items);
    if (featured.length) md += `### ${vi.featured} / ${en.featured}\n\n${featured.map(courseLine).join('\n')}\n\n`;
    if (others.length) md += `### ${vi.allCourses} / ${en.allCourses}\n\n${others.map(courseLine).join('\n')}\n\n`;
  }

  md += `## ${vi.pathsTab} / ${en.pathsTab} (${learningPaths.items.length})\n\n`;
  md += `Source: ${LAB200_ORIGIN}/learning-paths.json\n\n${synced(learningPaths)}`;
  md += learningPaths.items.length === 0
    ? `_${en.emptyPaths}_ ${home}\n`
    : `${learningPaths.items.map(pathLine).join('\n')}\n`;
  return md;
}
