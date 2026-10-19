/**
 * Interactive block, kept in its own module so the Zuey AI artifact validator can check one block
 * without loading the whole registry.
 */
import type { BlockDefinition } from '../block-definition';
import { LIMITS } from '../schema';
import type { InteractiveBlock } from '../schema';
import { short } from './schema-fragments';
import { isInt, plain, plainLength } from './shared';

export const interactive: BlockDefinition<InteractiveBlock> = {
  type: 'interactive',
  validate(v, raw, { id, path }) {
    const title = v.str(raw, 'title', path, LIMITS.shortText, { nonEmpty: true });
    const html = v.str(raw, 'html', path, LIMITS.interactiveField, { optional: true }) ?? '';
    const css = v.str(raw, 'css', path, LIMITS.interactiveField, { optional: true }) ?? '';
    const js = v.str(raw, 'js', path, LIMITS.interactiveField, { optional: true }) ?? '';
    const caption = v.str(raw, 'caption', path, LIMITS.shortText, { optional: true });
    if (html.length + css.length + js.length > LIMITS.interactiveTotal) {
      v.err(path, `html + css + js must be at most ${LIMITS.interactiveTotal} characters in total`);
      return undefined;
    }
    if (!html.trim() && !js.trim()) { v.err(`${path}.html`, 'html or js must not be empty'); return undefined; }
    if (raw.height !== undefined && !isInt(raw.height, LIMITS.interactiveHeightMin, LIMITS.interactiveHeightMax)) {
      v.err(`${path}.height`, `must be an integer ${LIMITS.interactiveHeightMin}–${LIMITS.interactiveHeightMax}`);
      return undefined;
    }
    const height = typeof raw.height === 'number' ? raw.height : undefined;
    if (title === undefined) return undefined;
    return { id, type: 'interactive', title, html, css, js, ...(height ? { height } : {}), ...(caption ? { caption } : {}) };
  },
  markdown(b, ctx) {
    // Source code never leaves the sandboxed renderer through Markdown: text fallback plus a link to run it.
    const where = ctx.articleUrl ? `[Open the interactive version](${ctx.articleUrl})` : '(open the article page to run it)';
    return `**Interactive:** ${b.title}${b.caption ? `\n\n*${b.caption}*` : ''}\n\n${where}`;
  },
  // Search indexes reading text only; the demo's source is not prose.
  searchText: () => [],
  aiText: b => [b.title, plain(b.caption)].join(' '),
  weight: b => 40 + plainLength(b.title) + plainLength(b.caption),
  schema: {
    properties: {
      title: short,
      html: { type: 'string', maxLength: LIMITS.interactiveField, description: 'Body HTML' },
      css: { type: 'string', maxLength: LIMITS.interactiveField },
      js: { type: 'string', maxLength: LIMITS.interactiveField, description: 'Runs in a sandboxed opaque-origin iframe with CSP connect-src none; call zuey.fetch(url) for allowlisted GET requests via the server proxy' },
      height: { type: 'integer', minimum: LIMITS.interactiveHeightMin, maximum: LIMITS.interactiveHeightMax },
      caption: short,
    },
    required: ['title'],
  },
};
