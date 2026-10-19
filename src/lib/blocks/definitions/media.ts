/** Media blocks: image, embed, math, gallery, audio, video, file and bookmark. */
import type { BlockDefinition, BlockValidator, RawBlock } from '../block-definition';
import { EMBED_PROVIDERS, LIMITS, isPdfUrl } from '../schema';
import type {
  AudioBlock, BookmarkBlock, EmbedBlock, EmbedProvider, FileBlock, GalleryBlock, GalleryImage, ImageBlock, MathBlock, VideoBlock,
} from '../schema';
import { PROVIDER_LABELS, detectProvider } from '../embed';
import { fileName, formatBytes, linkText, mdCaption } from '../markdown-format';
import { httpsUrl, imageSize, imageSizeTogether, short } from './schema-fragments';
import { isInt, isObj, isOneOf, plain, plainLength } from './shared';

const S = LIMITS.shortText;

/** Optional caption shared by the knowledge media blocks (read first, as stored documents expect). */
function captionOf(v: BlockValidator, raw: RawBlock, path: string): { caption?: string } {
  const caption = v.str(raw, 'caption', path, S, { optional: true });
  return caption ? { caption } : {};
}

export const image: BlockDefinition<ImageBlock> = {
  type: 'image',
  validate(v, raw, { id, path }) {
    const url = v.url(raw, 'url', path);
    const alt = v.str(raw, 'alt', path, S, { optional: true }) ?? '';
    const caption = v.str(raw, 'caption', path, S, { optional: true });
    const size = v.imageSize(raw, path);
    return url && size ? { id, type: 'image', url, alt, ...size, ...(caption ? { caption } : {}) } : undefined;
  },
  markdown: b => `![${b.alt.replace(/[[\]]/g, '')}](${b.url})${b.caption ? `\n\n*${b.caption}*` : ''}`,
  searchText: b => [b.alt, plain(b.caption)],
  aiText: b => [b.alt, plain(b.caption)].join(' '),
  weight: b => 40 + plainLength(b.alt) + plainLength(b.caption),
  schema: { properties: { url: httpsUrl, alt: short, caption: short, ...imageSize }, required: ['url'], extra: { dependentRequired: imageSizeTogether } },
};

export const embed: BlockDefinition<EmbedBlock> = {
  type: 'embed',
  validate(v, raw, { id, path }) {
    const url = v.url(raw, 'url', path);
    if (!url) return undefined;
    const detected = detectProvider(url);
    let provider: EmbedProvider = detected;
    if (raw.provider !== undefined) {
      // The provider decides which player host is framed, so it must come from the URL itself.
      // `generic` stays allowed: it only downgrades the embed to a plain link.
      const given = raw.provider;
      const valid = isOneOf(EMBED_PROVIDERS, given) && (given === detected || given === 'generic');
      if (valid) {
        provider = given;
      } else if (v.lenient) {
        // A stored embed keeps its content as a plain link rather than losing the whole block.
        v.degraded();
        provider = 'generic';
      } else if (!isOneOf(EMBED_PROVIDERS, given)) {
        v.err(`${path}.provider`, `must be one of ${EMBED_PROVIDERS.join(', ')}`);
        return undefined;
      } else {
        v.err(`${path}.provider`, `"${given}" does not match the URL host (detected "${detected}"); omit provider or use "${detected}"`);
        return undefined;
      }
    }
    const caption = v.str(raw, 'caption', path, S, { optional: true });
    return { id, type: 'embed', url, provider, ...(caption ? { caption } : {}) };
  },
  markdown: b => `${b.caption ? `${b.caption}\n\n` : ''}[${PROVIDER_LABELS[b.provider]}: ${b.url}](${b.url})`,
  searchText: b => [plain(b.caption)],
  aiText: b => plain(b.caption),
  weight: b => 40 + plainLength(b.caption),
  schema: {
    properties: {
      url: httpsUrl,
      provider: { type: 'string', enum: [...EMBED_PROVIDERS], description: 'Detected from the URL when omitted. When sent it must equal the detected provider, or be `generic` to show a plain link; any other value is rejected with 422 invalid_document. Rendered as a centred embed that loads when scrolled into view (readers can switch to click-to-load per device), with a link to the original URL.' },
      caption: short,
    },
    required: ['url'],
  },
};

export const math: BlockDefinition<MathBlock> = {
  type: 'math',
  validate(v, raw, { id, path }) {
    const withCaption = captionOf(v, raw, path);
    const tex = v.str(raw, 'tex', path, LIMITS.math, { nonEmpty: true });
    return tex === undefined ? undefined : { id, type: 'math', tex, ...withCaption };
  },
  markdown: b => `$$\n${b.tex}\n$$${mdCaption(b.caption)}`,
  searchText: b => [b.tex, plain(b.caption)],
  aiText: b => [b.tex, plain(b.caption)].join(' '),
  weight: b => b.tex.length + plainLength(b.caption),
  schema: { properties: { tex: { type: 'string', maxLength: LIMITS.math, description: 'TeX source; shown as accessible source text' }, caption: short }, required: ['tex'] },
};

export const gallery: BlockDefinition<GalleryBlock> = {
  type: 'gallery',
  validate(v, raw, { id, path }) {
    const withCaption = captionOf(v, raw, path);
    if (!Array.isArray(raw.images) || raw.images.length < 1 || raw.images.length > LIMITS.galleryImages) {
      v.err(`${path}.images`, `must contain 1–${LIMITS.galleryImages} images`);
      return undefined;
    }
    const images: GalleryImage[] = [];
    raw.images.forEach((img: unknown, i: number) => {
      const p = `${path}.images[${i}]`;
      if (!isObj(img)) { v.err(p, 'must be an object {url, alt, caption?, width?, height?}'); return; }
      const url = v.url(img, 'url', p);
      const alt = v.str(img, 'alt', p, S, { optional: true }) ?? '';
      const imgCaption = v.str(img, 'caption', p, S, { optional: true });
      const size = v.imageSize(img, p);
      if (url && size) images.push({ url, alt, ...size, ...(imgCaption ? { caption: imgCaption } : {}) });
    });
    return images.length === raw.images.length ? { id, type: 'gallery', images, ...withCaption } : undefined;
  },
  markdown: b => b.images.map(img => `![${linkText(img.alt)}](${img.url})${img.caption ? ` — ${img.caption}` : ''}`).join('\n\n') + mdCaption(b.caption),
  searchText: b => [...b.images.flatMap(i => [i.alt, plain(i.caption)]), plain(b.caption)],
  aiText: b => [...b.images.map(img => [img.alt, plain(img.caption)].join(' ')), plain(b.caption)].join(' '),
  weight: b => b.images.reduce((n, img) => n + 40 + plainLength(img.alt) + plainLength(img.caption), 0) + plainLength(b.caption),
  schema: {
    properties: {
      images: {
        type: 'array', minItems: 1, maxItems: LIMITS.galleryImages,
        items: { type: 'object', required: ['url'], properties: { url: httpsUrl, alt: short, caption: short, ...imageSize }, dependentRequired: imageSizeTogether },
      },
      caption: short,
    },
    required: ['images'],
  },
};

export const audio: BlockDefinition<AudioBlock> = {
  type: 'audio',
  validate(v, raw, { id, path }) {
    const withCaption = captionOf(v, raw, path);
    const url = v.url(raw, 'url', path);
    const title = v.str(raw, 'title', path, S, { optional: true });
    return url ? { id, type: 'audio', url, ...(title ? { title } : {}), ...withCaption } : undefined;
  },
  markdown: b => `[Audio: ${linkText(b.title || fileName(b.url))}](${b.url})${mdCaption(b.caption)}`,
  searchText: b => [b.title ?? '', plain(b.caption)],
  aiText: b => [b.title ?? '', plain(b.caption)].join(' '),
  weight: b => 40 + plainLength(b.title) + plainLength(b.caption),
  schema: { properties: { url: httpsUrl, title: short, caption: short }, required: ['url'] },
};

export const video: BlockDefinition<VideoBlock> = {
  type: 'video',
  validate(v, raw, { id, path }) {
    const withCaption = captionOf(v, raw, path);
    const url = v.url(raw, 'url', path);
    const poster = v.optUrl(raw, 'poster', path);
    const title = v.str(raw, 'title', path, S, { optional: true });
    if (!url || poster === null) return undefined;
    return { id, type: 'video', url, ...(poster ? { poster } : {}), ...(title ? { title } : {}), ...withCaption };
  },
  markdown: b => `[Video: ${linkText(b.title || fileName(b.url))}](${b.url})${mdCaption(b.caption)}`,
  searchText: b => [b.title ?? '', plain(b.caption)],
  aiText: b => [b.title ?? '', plain(b.caption)].join(' '),
  weight: b => 40 + plainLength(b.title) + plainLength(b.caption),
  schema: { properties: { url: httpsUrl, poster: httpsUrl, title: short, caption: short }, required: ['url'] },
};

export const file: BlockDefinition<FileBlock> = {
  type: 'file',
  validate(v, raw, { id, path }) {
    const withCaption = captionOf(v, raw, path);
    const url = v.url(raw, 'url', path);
    const name = v.str(raw, 'name', path, S, { nonEmpty: true });
    const size = raw.sizeBytes;
    if (size !== undefined && !isInt(size, 0, Number.MAX_SAFE_INTEGER)) { v.err(`${path}.sizeBytes`, 'must be a non-negative integer'); return undefined; }
    if (!url || name === undefined) return undefined;
    return { id, type: 'file', url, name, ...(typeof size === 'number' ? { sizeBytes: size } : {}), ...withCaption };
  },
  markdown(b) {
    const size = b.sizeBytes !== undefined ? `, ${formatBytes(b.sizeBytes)}` : '';
    const kind = isPdfUrl(b.url) ? 'PDF' : 'File';
    return `[${kind}: ${linkText(b.name)}${size}](${b.url})${mdCaption(b.caption)}`;
  },
  searchText: b => [b.name, plain(b.caption)],
  aiText: b => [b.name, plain(b.caption)].join(' '),
  weight: b => 20 + plainLength(b.name) + plainLength(b.caption),
  schema: { properties: { url: httpsUrl, name: short, sizeBytes: { type: 'integer', minimum: 0 }, caption: short }, required: ['url', 'name'] },
};

export const bookmark: BlockDefinition<BookmarkBlock> = {
  type: 'bookmark',
  validate(v, raw, { id, path }) {
    captionOf(v, raw, path);
    const url = v.url(raw, 'url', path);
    const title = v.str(raw, 'title', path, S, { optional: true });
    const description = v.str(raw, 'description', path, 1_000, { optional: true });
    const siteName = v.str(raw, 'siteName', path, 120, { optional: true });
    const image = v.optUrl(raw, 'image', path);
    if (!url || image === null) return undefined;
    return {
      id, type: 'bookmark', url, ...(title ? { title } : {}), ...(description ? { description } : {}),
      ...(image ? { image } : {}), ...(siteName ? { siteName } : {}),
    };
  },
  markdown(b) {
    const title = linkText(b.title || b.url);
    const meta = [b.siteName, b.description].filter(Boolean).join(' — ');
    return `[${title}](${b.url})${meta ? `\n\n> ${meta.replace(/\r?\n/g, ' ')}` : ''}`;
  },
  searchText: b => [b.title ?? '', b.description ?? '', b.siteName ?? ''],
  aiText: b => [b.title ?? '', b.siteName ?? '', b.description ?? ''].join(' '),
  weight: b => 20 + plainLength(b.title) + plainLength(b.description),
  schema: {
    properties: { url: httpsUrl, title: short, description: { type: 'string', maxLength: 1000 }, image: httpsUrl, siteName: { type: 'string', maxLength: 120 } },
    required: ['url'],
  },
};
