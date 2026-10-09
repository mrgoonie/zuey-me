/**
 * Admin write flows shared by REST, MCP, Studio and the CLI: add a YouTube link (optionally as the
 * other-language edition of an existing video) and (re)fetch its transcript through AnyMD.
 * A transcript failure never blocks the add: the edition is stored with a visible failed/unavailable status.
 */
import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import type { FetchLike } from '../reads/anymd-client';
import { parseAnyMdVideo } from './anymd-transcript-parser';
import { fetchVideoMarkdown, TranscriptFetchError } from './anymd-transcript-client';
import {
  createVideo, deleteVideo, getEdition, getVideo, insertEdition, moveEdition, newVideoId, reindexEdition, saveTranscriptResult,
} from './store';
import type { VideoItem, VideoLocale } from './types';
import { fetchWatchMetadata } from './youtube-watch-metadata';
import { parseYoutubeId, thumbnailUrl } from './youtube-url';

export interface IngestDeps {
  db: D1DatabaseLike;
  anymdApiKey?: string;
  fetchImpl?: FetchLike;
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
}

async function resolveVideoId(db: D1DatabaseLike, ref: string): Promise<string> {
  const direct = await getVideo(db, ref.trim());
  if (direct) return direct.id;
  const yt = parseYoutubeId(ref);
  const byYoutube = yt ? await getVideo(db, yt) : null;
  if (!byYoutube) throw new AppError(404, 'video_not_found', `No curated video matches "${ref}"`);
  return byYoutube.id;
}

/** Fetches transcript + metadata and stores the outcome; returns the stored status. */
export async function refreshEdition(deps: IngestDeps, youtubeId: string, opts: { fresh?: boolean; titleOverride?: string } = {}): Promise<{ status: string; error: string | null }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const [markdown, watch] = await Promise.all([
    fetchVideoMarkdown(youtubeId, { apiKey: deps.anymdApiKey, fresh: opts.fresh, fetchImpl }).then(
      text => ({ ok: true as const, text }),
      (err: unknown) => ({ ok: false as const, error: err instanceof TranscriptFetchError ? err.message : 'AnyMD request failed' }),
    ),
    fetchWatchMetadata(youtubeId, fetchImpl),
  ]);
  const meta = { duration_seconds: watch.duration_seconds, published_at: watch.published_at };
  if (!markdown.ok) {
    await saveTranscriptResult(deps.db, youtubeId, { status: 'failed', error: markdown.error, description: watch.description ?? '', ...meta });
    await reindexEdition(deps.db, youtubeId);
    return { status: 'failed', error: markdown.error };
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
  return { status, error };
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
  return { video, youtube_id: youtubeId, transcript_status: outcome.status, transcript_error: outcome.error };
}

export async function refetchTranscript(deps: IngestDeps, ref: string): Promise<IngestResult> {
  const youtubeId = parseYoutubeId(ref) ?? ref;
  const edition = await getEdition(deps.db, youtubeId);
  if (!edition) throw new AppError(404, 'video_not_found', 'No Zueytube edition has that YouTube id');
  const outcome = await refreshEdition(deps, youtubeId, { fresh: true });
  const video = await getVideo(deps.db, edition.video_id);
  if (!video) throw new AppError(404, 'video_not_found', 'Video not found');
  return { video, youtube_id: youtubeId, transcript_status: outcome.status, transcript_error: outcome.error };
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
