import { courseLink, coursePrice, formatVnd, LAB200_ORIGIN, LAB200_REF, splitFeatured, type Lab200Course } from './courses';
import { LAB200_AUTHOR, lab200Copy } from './copy';
import type { Lab200Snapshot } from './store';

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function escapeLinkText(s: string): string {
  return oneLine(s).replace(/([\[\]])/g, '\\$1');
}

function courseLine(c: Lab200Course): string {
  const price = c.free ? null : coursePrice(c.status);
  const priceText = price
    ? `giá gốc ${price.from ? 'từ ' : ''}${formatVnd(price.base)}, qua link này ${formatVnd(price.discounted)} (−20%)`
    : c.status;
  const meta = [c.lessons !== null ? `${c.lessons} bài học` : '', priceText].filter(Boolean).join(' · ');
  return `- [${escapeLinkText(c.title)}](${courseLink(c.slug)}): ${oneLine(c.summary)}${meta ? ` · ${oneLine(meta)}` : ''}`;
}

/** /200lab.md: the same courses as the app, every link carrying the referral code. */
export function renderLab200Markdown(snapshot: Lab200Snapshot): string {
  const vi = lab200Copy('vi');
  const en = lab200Copy('en');
  let md = '# 200lab — Khoá học Duy giới thiệu / Courses Duy recommends\n\n';
  const author = (c: typeof vi) => `${c.author.before}${LAB200_AUTHOR.name}${c.author.after}[${LAB200_AUTHOR.company}](${LAB200_AUTHOR.companyUrl}).`;
  md += `${vi.intro}\n\n${en.intro}\n\n${author(vi)}\n${author(en)}\n\n`;
  md += `> ${vi.discount} (ref \`${LAB200_REF}\`). ${vi.disclosure}\n> ${en.discount}. ${en.disclosure}\n\n`;
  if (snapshot.syncedAt) md += `Last synced: ${snapshot.syncedAt}\n\n`;
  if (snapshot.courses.length === 0) return `${md}_${en.empty}_ ${LAB200_ORIGIN}/?ref=${LAB200_REF}\n`;
  const { featured, others } = splitFeatured(snapshot.courses);
  if (featured.length) md += `## ${vi.featured} / ${en.featured}\n\n${featured.map(courseLine).join('\n')}\n\n`;
  if (others.length) md += `## ${vi.all} / ${en.all}\n\n${others.map(courseLine).join('\n')}\n`;
  return md;
}
