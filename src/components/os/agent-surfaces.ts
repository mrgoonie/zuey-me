/**
 * Server-side renderers that describe Zuey OS to agents: the no-JS app index embedded in `/` and the
 * Markdown guide appended to llms.txt and index.md. Both list the same apps as app-directory.ts.
 */
import type { Profile } from '../../db/types';
import type { Locale } from '../../lib/i18n/locales';
import { absoluteUrl, appDirectory } from './app-directory';
import { WEBMCP_TOOL_SUMMARIES } from './webmcp-tools';

export const STATIC_INDEX_ID = 'zueyos-index';

const COPY: Record<'en' | 'vi', { title: string; how: string; apps: string; agents: string; links: { profile: string; docs: string; mcp: string } }> = {
  en: {
    title: 'Zuey OS apps',
    how: 'Zuey OS opens each app below as a window on this page. Most apps also have their own page:',
    apps: 'Apps',
    agents: 'For AI agents:',
    links: { profile: 'Markdown profile', docs: 'API docs', mcp: 'MCP server' },
  },
  vi: {
    title: 'Ứng dụng trong Zuey OS',
    how: 'Zuey OS mở từng ứng dụng dưới đây thành cửa sổ trên trang này. Phần lớn ứng dụng cũng có trang riêng:',
    apps: 'Ứng dụng',
    agents: 'Dành cho AI agent:',
    links: { profile: 'Hồ sơ Markdown', docs: 'Tài liệu API', mcp: 'MCP server' },
  },
};

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Semantic, visually hidden index of every app (sr-only, so no layout shift and no visible UX change).
 * Headings start at h2 because the app windows already render the page's h1s.
 * It mirrors what the dock shows, so it is equivalent content rather than cloaking. Links carry
 * tabindex="-1": screen readers reach them in browse mode, but keyboard Tab never lands on an
 * invisible focus stop (the dock already covers keyboard navigation).
 */
export function renderStaticIndexHtml(locale: Locale, profile: Pick<Profile, 'name' | 'handle' | 'intro_en' | 'intro_vi'>): string {
  const copy = locale === 'vi' ? COPY.vi : COPY.en;
  const intro = locale === 'vi' ? profile.intro_vi : profile.intro_en;
  const items = appDirectory(locale)
    .map(app => `<li data-app="${escapeHtml(app.id)}"><a href="${escapeHtml(app.route)}" tabindex="-1">${escapeHtml(app.name)}</a>: ${escapeHtml(app.summary)}</li>`)
    .join('');
  const agentLinks = [
    ['/llms.txt', 'llms.txt'], ['/index.md', copy.links.profile], ['/docs', copy.links.docs], ['/mcp', copy.links.mcp],
  ].map(([href, label]) => `<a href="${href}" tabindex="-1">${escapeHtml(label)}</a>`).join(' · ');
  return `<section id="${STATIC_INDEX_ID}" class="sr-only" data-locale="${escapeHtml(locale)}" aria-labelledby="${STATIC_INDEX_ID}-title">`
    + `<h2 id="${STATIC_INDEX_ID}-title">${escapeHtml(`${profile.name} (${profile.handle})`)}</h2>`
    + (intro ? `<p>${escapeHtml(intro)}</p>` : '')
    + `<nav aria-label="${escapeHtml(copy.title)}"><h3>${escapeHtml(copy.apps)}</h3><p>${escapeHtml(copy.how)}</p><ul>${items}</ul></nav>`
    + `<p>${escapeHtml(copy.agents)} ${agentLinks}</p>`
    + '</section>';
}

/** Markdown section for llms.txt and index.md (English, absolute URLs). */
export function zueyOsAgentGuideMarkdown(): string {
  const apps = appDirectory('en')
    .map(app => `- [${app.name}](${absoluteUrl(app.route)}) — ${app.summary} Deep link: ${absoluteUrl(app.deepLink)}`)
    .join('\n');
  const tools = WEBMCP_TOOL_SUMMARIES.map(t => `- \`${t.name}\`: ${t.summary}`).join('\n');
  const desktopOnly = appDirectory('en').filter(app => app.route.startsWith('/#')).map(app => app.name).join(', ');
  return `## Zuey OS (homepage)
${absoluteUrl('/')} is "Zuey OS", a desktop-style web app: each app below opens as a window, and the deep link \`${absoluteUrl('/#<app-id>')}\` opens its window on the desktop. Apps with their own page link to a standalone route: a normal URL that returns the page in its HTML, though interactive apps (chat, account, referral, booking) still need JavaScript and some need sign-in. ${desktopOnly} live only on the desktop, so their link is the deep link. The raw HTML of \`/\` also contains this app list.

${apps}

### Agent access
- Browser agents (WebMCP): on \`/\`, read/navigate-only tools are registered on \`document.modelContext\` (or the older \`navigator.modelContext\`) when the browser supports WebMCP:
${tools.split('\n').map(line => `  ${line}`).join('\n')}
- MCP clients: ${absoluteUrl('/mcp')} (Streamable HTTP, OAuth 2.1, members) and ${absoluteUrl('/api/mcp')} (anonymous read tools; API key for more).
- REST: ${absoluteUrl('/docs')} (OpenAPI: ${absoluteUrl('/api/openapi.json')}).
`;
}
