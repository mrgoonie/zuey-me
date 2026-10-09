/**
 * Admin write flows shared by REST, MCP, Studio and the CLI: add a YouTube link (optionally as the
 * other-language edition of an existing video) and (re)fetch its transcript through AnyMD.
 * A transcript failure never blocks the add: the edition is stored with a visible failed/unavailable status.
 * When an AI provider is configured (OpenRouter first, Workers AI as fallback), a fetched transcript is then cleaned up by AI;
 * a failed rewrite keeps the raw text.
 */
import type { D1DatabaseLike } from '../../db/store';
import type { WorkersAiLike } from '../../env';
import { AppError } from '../http';
import type { FetchLike } from '../reads/anymd-client';
import { parseAnyMdVideo, transcriptPlainText } from './anymd-transcript-parser';
import { fetchVideoMarkdown, TranscriptFetchError } from './anymd-transcript-client';
import {
  createVideo, deleteVideo, getEdition, getTranscriptSource, getVideo, insertEdition, moveEdition, newVideoId, reindexEdition,
  saveRewriteResult, saveTranscriptResult,
} from './store';
import type { TranscriptRewriteStatus, VideoItem, VideoLocale } from './types';
import { rewriteTranscript } from './video-transcript-rewrite';
import { DEFAULT_REWRITE_GLOSSARY, mergeGlossary, parseGlossary } from './video-transcript-glossary';
import { openRouterRewriter, workersAiRewriter, type TranscriptRewriter } from './video-transcript-rewrite-providers';
import { fetchWatchMetadata } from './youtube-watch-metadata';
import { parseYoutubeId, thumbnailUrl } from './youtube-url';

export interface IngestDeps {
  db: D1DatabaseLike;
  anymdApiKey?: string;
  fetchImpl?: FetchLike;
  /** OpenRouter key: preferred provider for the transcript rewrite. */
  openRouterApiKey?: string;
  openRouterModel?: string;
  /** Workers AI binding: fallback provider (or the only one without an OpenRouter key). */
  ai?: WorkersAiLike;
  rewriteModel?: string;
  /** Extra proper nouns for the rewrite prompt (VIDEOS_REWRITE_GLOSSARY format). */
  rewriteGlossary?: string;
}

/** Providers in the order they are tried; empty means transcripts stay as raw captions. */
export function transcriptRewriters(deps: IngestDeps): TranscriptRewriter[] {
  const list: TranscriptRewriter[] = [];
  const key = deps.openRouterApiKey?.trim();
  if (key) list.push(openRouterRewriter(key, deps.openRouterModel?.trim() || undefined, deps.fetchImpl));
  if (deps.ai) list.push(workersAiRewriter(deps.ai, deps.rewriteModel?.trim() || undefined));
  return list;
}

export interface AddVideoInput {
  url: string;
  locale: VideoLocale;
  /** Existing video id, or a YouTube link/id of one of its editions, to attach this upload to. */
  pair_with?: string;
  /** Optional title override (otherwise AnyMD/YouTube metadata is used). */
  title?: string;
}

export interface IngestResult {
  video: VideoItem;
  youtube_id: string;
  transcript_status: string;
  transcript_error: string | null;
  transcript_rewrite_status: TranscriptRewriteStatus;
  transcript_rewrite_error: string | null;
}

async function resolveVideoId(db: D1DatabaseLike, ref: string): Promise<string> {
  const direct = await getVideo(db, ref.trim());
  if (direct) return direct.id;
  const yt = parseYoutubeId(ref);
  const byYoutube = yt ? await getVideo(db, yt) : null;
  if (!byYoutube) throw new AppError(404, 'video_not_found', `No curated video matches "${ref}"`);
  return byYoutube.id;
}

interface RefreshOutcome {
  status: string;
  error: string | null;
  rewrite_status: TranscriptRewriteStatus;
  rewrite_error: string | null;
}

/** Cleans up the stored raw transcript with AI and stores the outcome (the raw text stays on failure). */
async function applyRewrite(deps: IngestDeps, youtubeId: string, rewriters: TranscriptRewriter[]): Promise<{ status: TranscriptRewriteStatus; error: string | null }> {
  const source = await getTranscriptSource(deps.db, youtubeId);
  const edition = await getEdition(deps.db, youtubeId);
  if (!source || !edition) throw new AppError(409, 'transcript_not_ready', 'This edition has no transcript to rewrite yet');
  const model = rewriters.map(r => r.label).join(', ');
  try {
    const out = await rewriteTranscript(rewriters, source, {
      durationSeconds: edition.duration_seconds,
      title: edition.title,
      glossary: mergeGlossary(DEFAULT_REWRITE_GLOSSARY, parseGlossary(deps.rewriteGlossary)),
    });
    const wordCount = transcriptPlainText(out.transcript).split(/\s+/).filter(Boolean).length;
    await saveRewriteResult(deps.db, youtubeId, { status: 'ready', transcript: out.transcript, word_count: wordCount, model: out.model });
    await reindexEdition(deps.db, youtubeId);
    return { status: 'ready', error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'AI rewrite failed';
    await saveRewriteResult(deps.db, youtubeId, { status: 'failed', error, model });
    return { status: 'failed', error };
  }
}

/**
 * Fetches transcript + metadata (captions in the edition's language), stores the outcome and,
 * with an AI provider configured, rewrites a fetched transcript.
 */
export async function refreshEdition(deps: IngestDeps, youtubeId: string, opts: { fresh?: boolean; titleOverride?: string } = {}): Promise<RefreshOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const language = (await getEdition(deps.db, youtubeId))?.locale;
  const [markdown, watch] = await Promise.all([
    fetchVideoMarkdown(youtubeId, { apiKey: deps.anymdApiKey, fresh: opts.fresh, language, fetchImpl }).then(
      text => ({ ok: true as const, text }),
      (err: unknown) => ({ ok: false as const, error: err instanceof TranscriptFetchError ? err.message : 'AnyMD request failed' }),
    ),
    fetchWatchMetadata(youtubeId, fetchImpl),
  ]);
  const meta = { duration_seconds: watch.duration_seconds, published_at: watch.published_at };
  if (!markdown.ok) {
    await saveTranscriptResult(deps.db, youtubeId, { status: 'failed', error: markdown.error, description: watch.description ?? '', ...meta });
    await reindexEdition(deps.db, youtubeId);
    const kept = await getEdition(deps.db, youtubeId);
    return { status: 'failed', error: markdown.error, rewrite_status: kept?.transcript_rewrite_status ?? 'none', rewrite_error: kept?.transcript_rewrite_error ?? null };
  }
  const parsed = parseAnyMdVideo(markdown.text);
  const status = parsed.transcript ? 'ready' : 'unavailable';
  const error = parsed.transcript ? null : 'YouTube has no captions for this video yet';
  await saveTranscriptResult(deps.db, youtubeId, {
    status, error, transcript: parsed.transcript, word_count: parsed.word_count,
    title: opts.titleOverride || parsed.title, description: watch.description || parsed.description, author: parsed.author,
    thumbnail_url: parsed.thumbnail_url, ...meta,
  });
  await reindexEdition(deps.db, youtubeId);
  const rewriters = transcriptRewriters(deps);
  if (status !== 'ready' || rewriters.length === 0) return { status, error, rewrite_status: 'none', rewrite_error: null };
  const rewrite = await applyRewrite(deps, youtubeId, rewriters);
  return { status, error, rewrite_status: rewrite.status, rewrite_error: rewrite.error };
}

function ingestResult(video: VideoItem, youtubeId: string, o: RefreshOutcome): IngestResult {
  return {
    video, youtube_id: youtubeId, transcript_status: o.status, transcript_error: o.error,
    transcript_rewrite_status: o.rewrite_status, transcript_rewrite_error: o.rewrite_error,
  };
}

export async function addVideo(deps: IngestDeps, input: AddVideoInput): Promise<IngestResult> {
  const youtubeId = parseYoutubeId(input.url);
  if (!youtubeId) throw new AppError(400, 'invalid_youtube_url', 'Expected a YouTube video link (watch, youtu.be, shorts or embed) or an 11-character id');
  const existing = await getEdition(deps.db, youtubeId);
  if (existing) throw new AppError(409, 'video_exists', 'This YouTube video is already in Zueytube', { video_id: existing.video_id });

  let videoId: string;
  let created = false;
  if (input.pair_with) {
    videoId = await resolveVideoId(deps.db, input.pair_with);
    const target = await getVideo(deps.db, videoId);
    if (target?.editions.some(e => e.locale === input.locale)) {
      throw new AppError(409, 'edition_exists', `That video already has a ${input.locale.toUpperCase()} edition`);
    }
  } else {
    videoId = newVideoId();
    await createVideo(deps.db, videoId);
    created = true;
  }
  try {
    await insertEdition(deps.db, {
      youtube_id: youtubeId, video_id: videoId, locale: input.locale,
      title: input.title?.trim() || youtubeId, thumbnail_url: thumbnailUrl(youtubeId),
    });
  } catch (err) {
    if (created) await deleteVideo(deps.db, videoId).catch(() => undefined);
    throw err;
  }
  const outcome = await refreshEdition(deps, youtubeId, { titleOverride: input.title?.trim() });
  const video = await getVideo(deps.db, videoId);
  if (!video) throw new AppError(500, 'video_missing', 'The video was not stored');
  return ingestResult(video, youtubeId, outcome);
}

export async function refetchTranscript(deps: IngestDeps, ref: string): Promise<IngestResult> {
  const youtubeId = parseYoutubeId(ref) ?? ref;
  const edition = await getEdition(deps.db, youtubeId);
  if (!edition) throw new AppError(404, 'video_not_found', 'No Zueytube edition has that YouTube id');
  const outcome = await refreshEdition(deps, youtubeId, { fresh: true });
  const video = await getVideo(deps.db, edition.video_id);
  if (!video) throw new AppError(404, 'video_not_found', 'Video not found');
  return ingestResult(video, youtubeId, outcome);
}

/** Rewrites one edition's stored raw transcript with Workers AI again (no AnyMD call). */
export async function rewriteEditionTranscript(deps: IngestDeps, ref: string): Promise<IngestResult> {
  const youtubeId = parseYoutubeId(ref) ?? ref;
  const edition = await getEdition(deps.db, youtubeId);
  if (!edition) throw new AppError(404, 'video_not_found', 'No Zueytube edition has that YouTube id');
  const rewriters = transcriptRewriters(deps);
  if (rewriters.length === 0) throw new AppError(503, 'llm_unconfigured', 'No AI provider is configured (OPENROUTER_API_KEY or the Workers AI binding)');
  if (edition.transcript_status !== 'ready') throw new AppError(409, 'transcript_not_ready', 'This edition has no transcript to rewrite yet');
  const rewrite = await applyRewrite(deps, youtubeId, rewriters);
  const video = await getVideo(deps.db, edition.video_id);
  if (!video) throw new AppError(404, 'video_not_found', 'Video not found');
  return ingestResult(video, youtubeId, { status: edition.transcript_status, error: edition.transcript_error, rewrite_status: rewrite.status, rewrite_error: rewrite.error });
}

/** Attaches an existing edition to another video (manual VI/EN pairing after the fact). */
export async function pairEdition(db: D1DatabaseLike, youtubeRef: string, targetRef: string): Promise<VideoItem> {
  const youtubeId = parseYoutubeId(youtubeRef) ?? youtubeRef;
  const edition = await getEdition(db, youtubeId);
  if (!edition) throw new AppError(404, 'video_not_found', 'No Zueytube edition has that YouTube id');
  const targetId = await resolveVideoId(db, targetRef);
  const target = await getVideo(db, targetId);
  if (target && target.id !== edition.video_id && target.editions.some(e => e.locale === edition.locale)) {
    throw new AppError(409, 'edition_exists', `That video already has a ${edition.locale.toUpperCase()} edition`);
  }
  await moveEdition(db, youtubeId, targetId);
  const video = await getVideo(db, targetId);
  if (!video) throw new AppError(404, 'video_not_found', 'Video not found');
  return video;
}
