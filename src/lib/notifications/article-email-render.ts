import type { ArticleAccess, ArticleDocument, Block } from '../blocks/schema';
import { parseInline } from '../blocks/inline';
import type { InlineNode } from '../blocks/inline';
import { inlineToPlain } from '../blocks/inline';
import { applyPaywall } from '../blocks/paywall';
import { escapeHtml } from '../members/runtime';

/**
 * New-article email: article blocks rendered as conservative, inline-styled HTML that mail clients display reliably,
 * plus a plain-text part. Interactive blocks (charts, diagrams, surveys, embeds, media) become links to the article.
 * The member-specific footer (unsubscribe link) is added per recipient by `withFooter`.
 */
export type ArticleEmailMode = 'full' | 'teaser';

export interface ArticleEmailInput {
  locale: string;
  title: string;
  excerpt: string;
  access: ArticleAccess;
  coverUrl: string | null;
  document: ArticleDocument;
  articleUrl: string;
  pricingUrl: string;
  siteUrl: string;
  mode: ArticleEmailMode;
}

export interface ArticleEmailBody {
  subject: string;
  /** Body without the closing footer; pass to `withFooter`. */
  html: string;
  text: string;
}

/** Gmail clips messages over ~102 KB; the article body stops well before that and links to the web version. */
const HTML_BODY_BUDGET = 70_000;

interface Copy {
  preheaderPaid: string;
  readOnWeb: string;
  readFull: string;
  continueOnWeb: string;
  viewOnWeb: (what: string) => string;
  lockedTitle: string;
  lockedBody: string;
  subscribe: string;
  footer: string;
  unsubscribe: string;
  why: string;
}

const COPY: Record<'vi' | 'en', Copy> = {
  vi: {
    preheaderPaid: 'Bài viết mới trên Zuey',
    readOnWeb: 'Đọc trên zuey.me',
    readFull: 'Đọc toàn bộ bài viết',
    continueOnWeb: 'Bài viết còn tiếp. Đọc phần còn lại trên zuey.me.',
    viewOnWeb: what => `Xem ${what} trên zuey.me`,
    lockedTitle: 'Phần còn lại dành cho thành viên trả phí',
    lockedBody: 'Đăng ký gói Knowledges (hoặc gói Kết hợp / Cộng đồng) để đọc trọn bài này và toàn bộ kho kiến thức.',
    subscribe: 'Đăng ký để đọc tiếp',
    footer: 'Bạn nhận email này vì đã có tài khoản Zuey với email đã xác minh.',
    unsubscribe: 'Huỷ nhận email bài viết mới',
    why: 'Zuey · zuey.me',
  },
  en: {
    preheaderPaid: 'New article on Zuey',
    readOnWeb: 'Read on zuey.me',
    readFull: 'Read the full article',
    continueOnWeb: 'The article continues on zuey.me.',
    viewOnWeb: what => `View the ${what} on zuey.me`,
    lockedTitle: 'The rest is for paying members',
    lockedBody: 'Subscribe to Knowledges (or the Combo / Community plan) to read this article in full and the whole library.',
    subscribe: 'Subscribe to keep reading',
    footer: 'You receive this email because you have a Zuey account with a verified email.',
    unsubscribe: 'Unsubscribe from new-article emails',
    why: 'Zuey · zuey.me',
  },
};

const BLOCK_LABELS: Record<'vi' | 'en', Record<string, string>> = {
  vi: { chart: 'biểu đồ', diagram: 'sơ đồ', survey: 'khảo sát', interactive: 'bản tương tác', embed: 'nội dung nhúng', audio: 'audio', video: 'video', math: 'công thức' },
  en: { chart: 'chart', diagram: 'diagram', survey: 'survey', interactive: 'interactive demo', embed: 'embed', audio: 'audio', video: 'video', math: 'formula' },
};

function copyFor(locale: string): Copy {
  return locale === 'vi' ? COPY.vi : COPY.en;
}

function labelsFor(locale: string): Record<string, string> {
  return locale === 'vi' ? BLOCK_LABELS.vi : BLOCK_LABELS.en;
}

const P = 'font-size:16px;line-height:1.65;margin:0 0 16px;color:#1c1917';
const LINK = 'color:#b45309;text-decoration:underline';

function absoluteUrl(url: string, siteUrl: string): string {
  return url.startsWith('/') ? `${siteUrl}${url}` : url;
}

function inlineHtml(text: string): string {
  const walk = (nodes: InlineNode[]): string => nodes.map(n => {
    switch (n.kind) {
      case 'text': return escapeHtml(n.value).replace(/\r?\n/g, '<br>');
      case 'code': return `<code style="font-family:Menlo,Consolas,monospace;font-size:14px;background:#f5f0eb;padding:1px 4px;border-radius:4px">${escapeHtml(n.value)}</code>`;
      case 'bold': return `<strong>${walk(n.children)}</strong>`;
      case 'italic': return `<em>${walk(n.children)}</em>`;
      case 'strike': return `<s>${walk(n.children)}</s>`;
      case 'mark': return `<span style="background:#fde68a">${walk(n.children)}</span>`;
      case 'link': return `<a href="${escapeHtml(n.href)}" style="${LINK}">${walk(n.children)}</a>`;
    }
  }).join('');
  return walk(parseInline(text));
}

function image(url: string, alt: string, caption: string | undefined, siteUrl: string): string {
  const cap = caption ? `<p style="font-size:13px;color:#78716c;margin:6px 0 0;text-align:center">${inlineHtml(caption)}</p>` : '';
  return `<div style="margin:0 0 20px"><img src="${escapeHtml(absoluteUrl(url, siteUrl))}" alt="${escapeHtml(alt)}" width="520" style="display:block;width:100%;max-width:520px;height:auto;border-radius:10px">${cap}</div>`;
}

function webLink(what: string, input: ArticleEmailInput, block: Block): string {
  const href = `${input.articleUrl}#${encodeURIComponent(block.id)}`;
  return `<p style="${P}"><a href="${escapeHtml(href)}" style="${LINK}">▶ ${escapeHtml(copyFor(input.locale).viewOnWeb(what))}</a></p>`;
}

function blockHtml(block: Block, input: ArticleEmailInput): string {
  const labels = labelsFor(input.locale);
  switch (block.type) {
    case 'paragraph': return `<p style="${P}">${inlineHtml(block.text)}</p>`;
    case 'heading': {
      const size = block.level === 1 ? 24 : block.level === 2 ? 20 : 17;
      return `<h${block.level + 1} style="font-family:Georgia,serif;font-size:${size}px;line-height:1.3;margin:28px 0 12px;color:#1c1917">${inlineHtml(block.text)}</h${block.level + 1}>`;
    }
    case 'list': {
      const tag = block.style === 'number' ? 'ol' : 'ul';
      return `<${tag} style="${P};padding-left:24px">${block.items.map(i => `<li style="margin:0 0 6px">${inlineHtml(i)}</li>`).join('')}</${tag}>`;
    }
    case 'checklist':
      return `<ul style="${P};list-style:none;padding-left:4px">${block.items.map(i => `<li style="margin:0 0 6px">${i.checked ? '☑' : '☐'} ${inlineHtml(i.text)}</li>`).join('')}</ul>`;
    case 'quote':
      return `<blockquote style="margin:0 0 16px;padding:4px 0 4px 16px;border-left:3px solid #d6a46b;color:#44403c"><p style="${P};font-style:italic;margin:0">${inlineHtml(block.text)}</p>${block.cite ? `<p style="font-size:14px;color:#78716c;margin:6px 0 0">— ${inlineHtml(block.cite)}</p>` : ''}</blockquote>`;
    case 'callout':
      return `<div style="margin:0 0 16px;padding:14px 16px;border-radius:10px;background:#fbf3e8"><p style="${P};margin:0">${inlineHtml(block.text)}</p></div>`;
    case 'code':
      return `<pre style="margin:0 0 16px;padding:14px;border-radius:10px;background:#1c1917;color:#f5f5f4;font-family:Menlo,Consolas,monospace;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word">${escapeHtml(block.code)}</pre>`;
    case 'divider': return '<hr style="border:none;border-top:1px solid #e7e0d8;margin:24px 0">';
    case 'image': return image(block.url, block.alt, block.caption, input.siteUrl);
    case 'gallery':
      return block.images.map(img => image(img.url, img.alt, img.caption, input.siteUrl)).join('')
        + (block.caption ? `<p style="font-size:13px;color:#78716c;margin:-8px 0 16px;text-align:center">${inlineHtml(block.caption)}</p>` : '');
    case 'table': {
      const cell = 'padding:8px;border:1px solid #e7e0d8;font-size:14px;text-align:left;vertical-align:top';
      return `<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 16px"><tr>${block.headers.map(h => `<th style="${cell};background:#f5f0eb">${inlineHtml(h)}</th>`).join('')}</tr>${block.rows.map(r => `<tr>${r.map(c => `<td style="${cell}">${inlineHtml(c)}</td>`).join('')}</tr>`).join('')}</table>`;
    }
    case 'bookmark':
      return `<p style="${P}"><a href="${escapeHtml(block.url)}" style="${LINK}"><strong>${escapeHtml(block.title || block.url)}</strong></a>${block.description ? `<br><span style="font-size:14px;color:#57534e">${escapeHtml(block.description)}</span>` : ''}</p>`;
    case 'file':
      return `<p style="${P}"><a href="${escapeHtml(absoluteUrl(block.url, input.siteUrl))}" style="${LINK}">⬇ ${escapeHtml(block.name)}</a></p>`;
    case 'toggle':
      return `<p style="${P}"><strong>${inlineHtml(block.summary)}</strong></p>${block.blocks.map(b => blockHtml(b, input)).join('')}`;
    case 'layout':
      return block.children.flatMap(c => c.blocks.map(b => blockHtml(b, input))).join('');
    case 'chart': case 'diagram': case 'survey': case 'interactive': case 'embed': case 'audio': case 'video': case 'math':
      return webLink(labels[block.type] ?? block.type, input, block);
  }
}

function blockText(block: Block, input: ArticleEmailInput): string {
  switch (block.type) {
    case 'paragraph': case 'callout': return inlineToPlain(block.text);
    case 'heading': return inlineToPlain(block.text).toUpperCase();
    case 'list': return block.items.map((i, n) => `${block.style === 'number' ? `${n + 1}.` : '-'} ${inlineToPlain(i)}`).join('\n');
    case 'checklist': return block.items.map(i => `[${i.checked ? 'x' : ' '}] ${inlineToPlain(i.text)}`).join('\n');
    case 'quote': return `“${inlineToPlain(block.text)}”${block.cite ? ` — ${inlineToPlain(block.cite)}` : ''}`;
    case 'code': return block.code;
    case 'divider': return '---';
    case 'table': return [block.headers, ...block.rows].map(r => r.map(inlineToPlain).join(' | ')).join('\n');
    case 'bookmark': return `${block.title || ''} ${block.url}`.trim();
    case 'toggle': return [inlineToPlain(block.summary), ...block.blocks.map(b => blockText(b, input))].join('\n\n');
    case 'layout': return block.children.flatMap(c => c.blocks.map(b => blockText(b, input))).filter(Boolean).join('\n\n');
    case 'image': case 'gallery': case 'file': return '';
    default: return `[${labelsFor(input.locale)[block.type] ?? block.type}: ${input.articleUrl}]`;
  }
}

function button(href: string, label: string): string {
  return `<p style="margin:24px 0"><a href="${escapeHtml(href)}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 22px;border-radius:999px">${escapeHtml(label)}</a></p>`;
}

/** Renders the shared (not member-specific) part of a new-article email for one edition and access mode. */
export function renderArticleEmail(input: ArticleEmailInput): ArticleEmailBody {
  const copy = copyFor(input.locale);
  const paywalled = input.mode === 'teaser' ? applyPaywall(input.document, input.access, { isAdmin: false, entitlements: [] }) : null;
  const blocks = paywalled ? paywalled.doc.blocks : input.document.blocks;
  const locked = paywalled?.truncated === true;

  const parts: string[] = [];
  const textParts: string[] = [];
  let size = 0;
  let clipped = false;
  for (const block of blocks) {
    const html = blockHtml(block, input);
    if (size + html.length > HTML_BODY_BUDGET && parts.length > 0) { clipped = true; break; }
    parts.push(html);
    size += html.length;
    const text = blockText(block, input);
    if (text) textParts.push(text);
  }

  const preheader = input.excerpt || copy.preheaderPaid;
  const cover = input.coverUrl ? image(input.coverUrl, input.title, undefined, input.siteUrl) : '';
  const ending = locked
    ? `<div style="margin:24px 0 0;padding:20px;border-radius:14px;background:#fbf3e8;text-align:center"><p style="font-family:Georgia,serif;font-size:19px;margin:0 0 8px;color:#1c1917">${escapeHtml(copy.lockedTitle)}</p><p style="font-size:15px;line-height:1.6;margin:0;color:#44403c">${escapeHtml(copy.lockedBody)}</p>${button(input.pricingUrl, copy.subscribe)}</div>`
    : clipped
      ? `<p style="${P}">${escapeHtml(copy.continueOnWeb)}</p>${button(input.articleUrl, copy.readFull)}`
      : button(input.articleUrl, copy.readOnWeb);

  const html = `<!doctype html><html lang="${escapeHtml(input.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title></head>
<body style="margin:0;padding:0;background:#F5EFEB;font-family:Arial,Helvetica,sans-serif;color:#1c1917">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div>
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
<p style="font-size:12px;font-weight:bold;letter-spacing:.12em;text-transform:uppercase;color:#b45309;margin:0 0 8px">Zuey</p>
<h1 style="font-family:Georgia,serif;font-size:28px;line-height:1.25;margin:0 0 12px"><a href="${escapeHtml(input.articleUrl)}" style="color:#1c1917;text-decoration:none">${escapeHtml(input.title)}</a></h1>
${input.excerpt ? `<p style="font-size:17px;line-height:1.6;color:#57534e;margin:0 0 20px">${escapeHtml(input.excerpt)}</p>` : ''}
${cover}${parts.join('\n')}
${ending}`;

  const text = [
    input.title,
    input.excerpt,
    textParts.join('\n\n'),
    locked ? `${copy.lockedTitle}\n${copy.lockedBody}\n${copy.subscribe}: ${input.pricingUrl}` : `${clipped ? copy.readFull : copy.readOnWeb}: ${input.articleUrl}`,
  ].filter(Boolean).join('\n\n');

  return { subject: input.title, html, text };
}

/** Adds the member-specific footer (unsubscribe link) and closes the document. */
export function withFooter(body: ArticleEmailBody, locale: string, unsubscribeUrl: string): { html: string; text: string } {
  const copy = copyFor(locale);
  const html = `${body.html}
<hr style="border:none;border-top:1px solid #e7e0d8;margin:32px 0 16px">
<p style="font-size:12px;line-height:1.6;color:#78716c;margin:0">${escapeHtml(copy.footer)}<br><a href="${escapeHtml(unsubscribeUrl)}" style="color:#78716c;text-decoration:underline">${escapeHtml(copy.unsubscribe)}</a> · ${escapeHtml(copy.why)}</p>
</div></body></html>`;
  const text = `${body.text}\n\n--\n${copy.footer}\n${copy.unsubscribe}: ${unsubscribeUrl}`;
  return { html, text };
}
