/** MCP tool that sets an article's managed cover and social preview (admin only). */
import { AppError } from '../http';
import type { McpToolModule } from '../mcp/types';
import { requireDb } from '../taxonomy/common';
import { SOCIAL_PREVIEW_MODES } from './articles';
import { setArticleCover } from './article-cover';
import { mcpAdminActor } from './mcp';

export const articleCoverMcpModule: McpToolModule = {
  tools: [
    {
      name: 'article_cover_set',
      description: 'Admin: set the cover of an article from a managed media asset id (med_…, from media_upload_url / media_import / media_list / media_reconcile), for every edition at once and without touching any article body. Published editions use it immediately; drafts pick it up on publish. `social_preview.mode` picks what og:image/Twitter show: generated_card (default, the rendered card), cover (this cover) or custom_asset (its own asset). Requires expected_revision; returns a compact receipt with the new revision, never the document.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Article slug' },
          expected_revision: { type: 'integer', description: 'Article revision from article_get (optimistic concurrency)' },
          asset_id: { type: ['string', 'null'], description: 'Managed media asset id for the cover; null removes the managed cover (the first public image is used again). Omit to leave the cover unchanged.' },
          alt: { type: 'string', description: 'Cover alt text for every edition (a changed cover without alt resets alt text)' },
          alts: { type: 'object', additionalProperties: { type: 'string' }, description: 'Per-locale alt text, e.g. {"vi": "…", "en": "…"}; overrides alt for that locale' },
          social_preview: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: [...SOCIAL_PREVIEW_MODES] },
              asset_id: { type: 'string', description: 'Required with mode custom_asset' },
            },
          },
        },
        required: ['slug', 'expected_revision'],
      },
    },
  ],

  async call(name, args, ctx) {
    if (name !== 'article_cover_set') throw new AppError(400, 'unknown_tool', `Unknown tool: ${name}`);
    await mcpAdminActor(ctx);
    const slug = typeof args.slug === 'string' ? args.slug.trim() : '';
    if (!slug) throw new AppError(400, 'invalid_field', 'slug is required', { field: 'slug' });
    return setArticleCover(requireDb(ctx.d1), {
      slug, expectedRevision: args.expected_revision, assetId: args.asset_id, alt: args.alt, alts: args.alts, socialPreview: args.social_preview,
    });
  },
};
