/**
 * Markdown editions of the course catalog and a course page, for agents and llms.txt. Rendered as an
 * anonymous visitor: public prices, the outline, and the text of trial lessons only. Paid lessons
 * never appear here, whoever asks.
 */
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { documentToMarkdown } from '../blocks/markdown';
import { anonymousPrincipal } from '../members/policy';
import type { CourseCard } from './course-views';
import { courseCatalog, courseDetail, lessonView } from './course-views';
import { formatUsd } from './course-types';
import type { PublicLessonBlock, PublicLessonDocument } from './lesson-blocks';
import { lessonArticleDocument, lessonSegments } from './lesson-blocks';

function priceLine(card: CourseCard): string {
  const p = card.price;
  const members = Object.values(p.plan_discounts).some(v => v > 0)
    ? ` (thành viên trả phí giảm tới ${Math.max(...Object.values(p.plan_discounts))}%)`
    : '';
  return p.list_usd_cents > 0 ? `${formatUsd(p.list_usd_cents)}, mua một lần${members}` : 'Miễn phí';
}

export async function renderCatalogMarkdown(d1: D1DatabaseLike, env: RuntimeEnv, origin: string): Promise<string> {
  const cards = await courseCatalog(d1, env, anonymousPrincipal());
  const lines = [
    '# Khoá học — Zuey',
    '',
    `Khoá học tự biên soạn về xây dựng sản phẩm và dùng AI. Mua một lần, sở hữu mãi mãi. Bài học thử đọc được ở đây; bài trả phí chỉ đọc trong trình duyệt sau khi mua. Điều khoản: ${origin}/terms · Chính sách: ${origin}/policy`,
    '',
  ];
  if (cards.length === 0) lines.push('_Chưa có khoá học nào được mở bán._');
  for (const c of cards) {
    lines.push(`## [${c.title}](${origin}${c.url})`, '');
    if (c.subtitle) lines.push(c.subtitle, '');
    lines.push(`- Giá: ${priceLine(c)}`, `- ${c.lesson_count} bài học (${c.trial_lesson_count} bài học thử), khoảng ${c.duration_minutes} phút`);
    if (c.release_note) lines.push(`- Lộ trình phát hành: ${c.release_note}`);
    lines.push(`- Markdown: ${origin}${c.url}.md`, '');
  }
  return lines.join('\n');
}

function widgetMarkdown(block: PublicLessonBlock): string {
  if (block.type === 'quiz') {
    const qs = block.questions.map((q, i) => `${i + 1}. ${q.prompt}\n${q.options.map(o => `   - ${o.label}`).join('\n')}`);
    return `**Quiz${block.title ? `: ${block.title}` : ''}** (làm trên trang để được chấm điểm)\n\n${qs.join('\n')}`;
  }
  if (block.type === 'course_media') return `_[Media: ${block.title ?? 'video/audio'} — xem trên trang]_`;
  if (block.type === 'github_repo') return `_[Repo GitHub riêng tư dành cho học viên: ${block.title ?? block.repo}]_`;
  return '';
}

function lessonMarkdown(doc: PublicLessonDocument): string {
  return lessonSegments(doc.blocks).map(seg => (seg.kind === 'article'
    ? documentToMarkdown(lessonArticleDocument({ version: 1, blocks: seg.blocks }))
    : widgetMarkdown(seg.block))).filter(Boolean).join('\n\n');
}

export async function renderCourseMarkdown(d1: D1DatabaseLike, env: RuntimeEnv, origin: string, ref: string): Promise<string> {
  const anon = anonymousPrincipal();
  const course = await courseDetail(d1, env, anon, ref);
  const url = `${origin}${course.url}`;
  const lines = [`# ${course.title}`, '', `URL: ${url}`, `Giá: ${priceLine(course)}`, ''];
  if (course.subtitle) lines.push(course.subtitle, '');
  if (course.summary) lines.push(course.summary, '');
  if (course.outcomes.length) lines.push('## Bạn sẽ học được', '', ...course.outcomes.map(o => `- ${o}`), '');
  lines.push('## Nội dung khoá học', '');
  const trials: Array<{ slug: string; title: string }> = [];
  for (const s of course.outline) {
    lines.push(`### ${s.title}`, '');
    for (const l of s.lessons) {
      if (l.is_trial) trials.push({ slug: l.slug, title: l.title });
      lines.push(`- ${l.title}${l.is_trial ? ' (học thử)' : ''}${l.duration_minutes ? ` — ${l.duration_minutes} phút` : ''}`);
    }
    lines.push('');
  }
  for (const t of trials) {
    const view = await lessonView(d1, env, anon, course.slug, t.slug);
    if (!view.document) continue;
    lines.push(`## Học thử: ${t.title}`, '', lessonMarkdown(view.document), '');
  }
  lines.push('---', `Mua khoá học: ${url} · Điều khoản: ${origin}/terms · Chính sách không hoàn tiền: ${origin}/policy`, '');
  return lines.join('\n');
}
