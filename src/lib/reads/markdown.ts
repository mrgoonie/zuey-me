import type { ReadItem } from './store';

export const READS_AI_NOTICE = 'Summaries are generated automatically by AI and may be inaccurate; every entry links to the original article. / Tóm tắt do AI tạo tự động và có thể sai; luôn có link về bài gốc.';

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function escapeLinkText(s: string): string {
  return oneLine(s).replace(/([\[\]])/g, '\\$1');
}

export function renderReadsMarkdown(items: ReadItem[], lastSyncedAt: string | null): string {
  let md = '# Zuey Reads — Duy Nguyen /zuey/\n\n';
  md += 'Articles, videos and posts Zuey has read and recommends, with short AI summaries.\n\n';
  md += `> ${READS_AI_NOTICE}\n\n`;
  if (lastSyncedAt) md += `Last synced: ${lastSyncedAt}\n\n`;
  if (items.length === 0) return `${md}_No reads published yet._\n`;
  for (const r of items) {
    md += `## [${escapeLinkText(r.title || r.url)}](${r.url})\n`;
    const source = [r.site || r.domain, r.source_kind, r.published].filter(Boolean).join(' · ');
    if (source) md += `- Source: ${oneLine(source)}\n`;
    if (r.author) md += `- Author: ${oneLine(r.author)}\n`;
    md += `- URL: ${r.url}\n\n`;
    if (r.summary) md += `${oneLine(r.summary)}\n\n`;
  }
  return md;
}
