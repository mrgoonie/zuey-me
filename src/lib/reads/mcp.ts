import { AppError } from '../http';
import type { McpToolModule } from '../mcp/types';
import { getLastSyncedAt, listReads, listReadSources } from './store';
import { DEFAULT_SYNC_BATCH_LIMIT, MAX_SYNC_BATCH_LIMIT, parseSyncBatch, syncReadsFromEnv } from './sync';

export const readsMcpModule: McpToolModule = {
  tools: [
    {
      name: 'reads_list',
      description: 'List Zuey Reads: articles/videos Zuey recommends, with short AI summaries and links to the originals.',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Search in title, summary, site and domain' },
          source: { type: 'string', description: 'Filter by AnyMD source_kind (e.g. article, youtube)' },
          limit: { type: 'number', description: 'Max items (1-100, default 20)' },
        },
      },
    },
    {
      name: 'reads_sync',
      description:
        'Admin only: sync one batch of Zuey Reads from the AnyMD library (items tagged zuey-reads) and summarize new or changed content. ' +
        `Each call processes at most limit tagged items (default ${DEFAULT_SYNC_BATCH_LIMIT}) starting at offset and returns next_offset; ` +
        'call again with offset = next_offset until next_offset is null to sync the whole library (one batch per call keeps each request under the edge timeout). ' +
        'Untagged items are hidden only by the final batch.',
      inputSchema: {
        type: 'object',
        properties: {
          offset: { type: 'number', description: 'Tagged items to skip (default 0); pass the previous next_offset' },
          limit: { type: 'number', description: `Tagged items to process in this call (1-${MAX_SYNC_BATCH_LIMIT}, default ${DEFAULT_SYNC_BATCH_LIMIT})` },
        },
      },
    },
  ],

  async call(name, args, ctx) {
    if (name === 'reads_list') {
      const q = typeof args.q === 'string' ? args.q : undefined;
      const source = typeof args.source === 'string' ? args.source : undefined;
      const limit = typeof args.limit === 'number' ? Math.min(100, Math.max(1, Math.trunc(args.limit))) : 20;
      const { items, total } = await listReads(ctx.d1, { q, source, limit });
      return { items, total, sources: await listReadSources(ctx.d1), last_synced_at: await getLastSyncedAt(ctx.d1) };
    }
    if (name === 'reads_sync') {
      await ctx.requireAdmin();
      const batch = parseSyncBatch(args);
      return syncReadsFromEnv(ctx.env, undefined, { offset: batch.offset ?? 0, limit: batch.limit ?? DEFAULT_SYNC_BATCH_LIMIT });
    }
    throw new AppError(400, 'unknown_tool', `Unknown tool: ${name}`);
  },
};
