/** MCP tools that put article images on the media CDN (https://media.zuey.me). All are admin-only. */
import { mcpAdminActor } from '../blocks/mcp';
import { AppError } from '../http';
import type { McpToolModule } from '../mcp/types';
import { requireDb } from '../taxonomy/common';
import { MAX_IMAGE_BYTES, deleteMediaAsset, imageBlock, listMediaAssets, storeImage } from './media-asset-store';
import { reconcileMediaObject } from './media-reconcile';
import { MAX_INLINE_BYTES, createUploadTicket, decodeBase64Image, importImageFromUrl } from './media-upload-sources';

const MB = 1024 * 1024;
const altProp = { alt: { type: 'string', description: 'Alt text describing the image (accessibility and SEO); reused in the returned block' } };
const RESULT_NOTE = 'Returns {asset, created, block, markdown}: insert `block` (an image block with width/height) into the article document, then call article_update.';

/** Public origin of this site, used to build upload URLs. */
function siteOrigin(env: { PUBLIC_SITE_URL?: string }, request: Request): string {
  return (env.PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  return typeof args[key] === 'number' ? args[key] : undefined;
}

export const mediaMcpModule: McpToolModule = {
  tools: [
    {
      name: 'media_upload_url',
      description: `Admin only: get a one-time URL (valid 15 minutes) to upload an image file to the media CDN. Preferred when you have a shell: run the returned curl command (curl --upload-file <path> <upload_url>), so the bytes never pass through the conversation. PNG, JPEG, GIF, WebP or AVIF up to ${MAX_IMAGE_BYTES / MB} MB. The PUT response is {asset, created, block, markdown}.`,
      inputSchema: { type: 'object', properties: { ...altProp } },
    },
    {
      name: 'media_import',
      description: `Admin only: copy an image from a public https URL onto the media CDN (e.g. a generated image), instead of hotlinking it. Redirects are not followed; pass the final URL. Up to ${MAX_IMAGE_BYTES / MB} MB. ${RESULT_NOTE}`,
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'https URL of the image' }, ...altProp }, required: ['url'] },
    },
    {
      name: 'media_upload',
      description: `Admin only: upload a small image sent inline as base64 (up to ${MAX_INLINE_BYTES / MB} MB), for clients without a shell. Prefer media_upload_url for files on disk. ${RESULT_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: { data_base64: { type: 'string', description: 'Image bytes as base64 or a data:image/...;base64, URL' }, ...altProp },
        required: ['data_base64'],
      },
    },
    {
      name: 'media_reconcile',
      description: `Admin only: register an image that is already in the media bucket (put there without media_upload_url or media_import, so it has no registry record) as a managed asset, so article_cover_set can use its id. Name the object by object_key or its https://media.zuey.me/<key> URL and give its sha256; the server reads the object from its own bucket (it never fetches URLs and never lists the bucket) and registers it only when the bytes are a PNG, JPEG, GIF, WebP or AVIF image up to ${MAX_IMAGE_BYTES / MB} MB whose SHA-256 (and width/height, when given) match. Identical bytes already managed under another key return that asset (duplicate_of_existing). ${RESULT_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          object_key: { type: 'string', description: 'Key in the bucket, e.g. blog/2026/10/cover.webp' },
          url: { type: 'string', description: 'Alternative to object_key: https://media.zuey.me/<key> (no query or fragment)' },
          sha256: { type: 'string', description: 'Expected SHA-256 of the file as 64 hex characters (sha256sum <file>)' },
          width: { type: 'integer', minimum: 1, description: 'Expected width in pixels' },
          height: { type: 'integer', minimum: 1, description: 'Expected height in pixels' },
          ...altProp,
        },
        required: ['sha256'],
      },
    },
    {
      name: 'media_list',
      description: 'Admin only: list images on the media CDN, newest first, each with a ready image block.',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Filter by alt text or object key' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          page: { type: 'integer', minimum: 1 },
        },
      },
    },
    {
      name: 'media_delete',
      description: 'Admin only: delete an image from the media CDN. Refused (409 media_in_use) while a current article or course lesson document, or a course cover, still uses it; older article revisions are not checked. CDN caches may keep serving a deleted image.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Media asset id (med_…)' } }, required: ['id'] },
    },
  ],

  async call(name, args, ctx) {
    const db = requireDb(ctx.d1);
    const actor = await mcpAdminActor(ctx);
    if (name === 'media_upload_url') return createUploadTicket(db, ctx.env, siteOrigin(ctx.env, ctx.request), { alt: args.alt, actor });
    if (name === 'media_import') return importImageFromUrl(db, ctx.env, args.url, { alt: args.alt, actor });
    if (name === 'media_upload') return storeImage(db, ctx.env, decodeBase64Image(args.data_base64), { alt: args.alt, actor });
    if (name === 'media_reconcile') return reconcileMediaObject(db, ctx.env, args, actor);
    if (name === 'media_list') {
      const res = await listMediaAssets(db, { q: typeof args.q === 'string' ? args.q : undefined, limit: optionalNumber(args, 'limit'), page: optionalNumber(args, 'page') });
      return { ...res, items: res.items.map(asset => ({ ...asset, block: imageBlock(asset) })) };
    }
    if (name === 'media_delete') {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      if (!id) throw new AppError(400, 'invalid_field', 'id is required', { field: 'id' });
      return deleteMediaAsset(db, ctx.env, id);
    }
    throw new AppError(400, 'unknown_tool', `Unknown tool: ${name}`);
  },
};
