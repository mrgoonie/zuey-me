import { AppError } from '../http';
import type { McpToolModule } from '../mcp/types';
import { requireDb } from '../taxonomy/common';
import { listVideos } from './store';
import { applyVideoPatch, parseAddVideoInput, removeVideoOrEdition } from './video-admin-operations';
import { getVideoDetail } from './video-detail';
import { addVideo, refetchTranscript, rewriteEditionTranscript } from './video-ingest-service';
import { searchVideos } from './video-search';
import { ingestDeps } from './route-helpers';

const idProp = { type: 'string', description: 'Video id (vid_…), YouTube id or YouTube link' };

function origin(env: { PUBLIC_SITE_URL?: string }): string {
  return (env.PUBLIC_SITE_URL || 'https://zuey.me').replace(/\/$/, '');
}

function requireRef(args: Record<string, unknown>): string {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) throw new AppError(400, 'missing_id', '"id" is required');
  return id;
}

export const videosMcpModule: McpToolModule = {
  tools: [
    {
      name: 'videos_list',
      description: 'List Zueytube: curated videos from Zuey\'s YouTube channel (@imzuey), grouped by VI/EN edition. With q, searches titles, descriptions and transcripts.',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Search titles, descriptions and transcripts' },
          limit: { type: 'number', description: 'Max items (1-100, default 30)' },
        },
      },
    },
    {
      name: 'video_get',
      description: 'Get one Zueytube video with its editions, full timestamped transcripts and automatically related articles.',
      inputSchema: { type: 'object', properties: { id: idProp }, required: ['id'] },
    },
    {
      name: 'video_add',
      description: 'Admin only: add a YouTube link to Zueytube. Fetches its transcript once via AnyMD; a missing transcript never blocks the add. Use pair_with to attach it as the other-language edition of an existing video.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'YouTube link or id' },
          locale: { type: 'string', enum: ['vi', 'en'], description: 'Language of this upload (default vi)' },
          pair_with: { type: 'string', description: 'Existing video id or YouTube id/link to pair with' },
          title: { type: 'string', description: 'Optional title override' },
        },
        required: ['url'],
      },
    },
    {
      name: 'video_update',
      description: 'Admin only: update a video (position, featured) or, given a YouTube id, an edition (title, description, locale, pair_with).',
      inputSchema: {
        type: 'object',
        properties: {
          id: idProp,
          position: { type: 'number' },
          featured: { type: 'boolean' },
          title: { type: 'string' },
          description: { type: 'string' },
          locale: { type: 'string', enum: ['vi', 'en'] },
          pair_with: { type: 'string', description: 'Move this edition under another video (id or YouTube id)' },
        },
        required: ['id'],
      },
    },
    {
      name: 'video_delete',
      description: 'Admin only: remove a whole video (video id) or a single edition (YouTube id/link).',
      inputSchema: { type: 'object', properties: { id: idProp }, required: ['id'] },
    },
    {
      name: 'video_refetch_transcript',
      description: 'Admin only: fetch the transcript of one edition again through AnyMD (e.g. after YouTube added captions).',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'YouTube id or link of the edition' } }, required: ['id'] },
    },
    {
      name: 'video_rewrite_transcript',
      description: 'Admin only: clean up one edition\'s raw captions again with Workers AI (punctuation, paragraphs, filler words; same language, no summary). Timestamps become estimates; a failed rewrite keeps the raw text.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'YouTube id or link of the edition' } }, required: ['id'] },
    },
  ],

  async call(name, args, ctx) {
    const db = requireDb(ctx.d1);
    if (name === 'videos_list') {
      const limit = typeof args.limit === 'number' ? Math.min(100, Math.max(1, Math.trunc(args.limit))) : 30;
      const q = typeof args.q === 'string' ? args.q.trim() : '';
      if (q) return { query: q, results: await searchVideos(db, q, { limit, origin: origin(ctx.env) }) };
      return listVideos(db, { limit });
    }
    if (name === 'video_get') {
      const detail = await getVideoDetail(db, requireRef(args), origin(ctx.env));
      if (!detail) throw new AppError(404, 'video_not_found', 'Video not found');
      return detail;
    }
    if (name === 'video_add') {
      await ctx.requireAdmin();
      return addVideo({ ...ingestDeps(ctx.env), db }, parseAddVideoInput(args));
    }
    if (name === 'video_update') {
      await ctx.requireAdmin();
      return applyVideoPatch(db, requireRef(args), args);
    }
    if (name === 'video_delete') {
      await ctx.requireAdmin();
      return removeVideoOrEdition(db, requireRef(args));
    }
    if (name === 'video_refetch_transcript') {
      await ctx.requireAdmin();
      return refetchTranscript({ ...ingestDeps(ctx.env), db }, requireRef(args));
    }
    if (name === 'video_rewrite_transcript') {
      await ctx.requireAdmin();
      return rewriteEditionTranscript({ ...ingestDeps(ctx.env), db }, requireRef(args));
    }
    throw new AppError(400, 'unknown_tool', `Unknown tool: ${name}`);
  },
};
