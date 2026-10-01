import type { PublicWorkflow } from './store';

const SITE = 'https://zuey.me';

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function workflowToMarkdown(w: PublicWorkflow): string {
  let md = `# ${oneLine(w.name)}\n\n> ${oneLine(w.summary)}\n\n`;
  md += `URL: ${SITE}/workflows/${w.slug}\n`;
  md += `Published: ${w.published_at}\n\n`;
  md += `## Trigger\n\n${w.trigger}\n\n`;
  md += `## Steps\n\n`;
  w.steps.forEach((s, i) => {
    md += `${i + 1}. **${oneLine(s.title)}**${s.detail ? `\n   ${s.detail.replace(/\n/g, '\n   ')}` : ''}\n`;
  });
  if (w.tools.length) md += `\n## Tools\n\n${w.tools.map(t => `- ${t}`).join('\n')}\n`;
  if (w.metrics.length) md += `\n## Metrics\n\n${w.metrics.map(m => `- ${m.label}: ${m.value}`).join('\n')}\n`;
  if (w.tags.length) md += `\n## Tags\n\n${w.tags.map(t => `\`${t}\``).join(' ')}\n`;
  return md;
}

export function workflowsIndexMarkdown(list: PublicWorkflow[]): string {
  let md = `# Zuey's AI Workflows\n\n> Real AI workflows Duy Nguyen /zuey/ uses day to day.\n\n`;
  if (list.length === 0) return md + 'No workflows published yet.\n';
  for (const w of list) {
    md += `- [${oneLine(w.name)}](${SITE}/workflows/${w.slug}.md) — ${oneLine(w.summary)} (${w.steps.length} steps; tools: ${w.tools.join(', ') || 'n/a'})\n`;
  }
  return md;
}

export function markdownResponse(md: string, status = 200): Response {
  return new Response(md, {
    status,
    headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}
