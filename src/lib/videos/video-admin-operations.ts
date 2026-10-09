/**
 * Input validation and admin edits shared by the REST routes and MCP tools, so both surfaces accept
 * the same fields and return the same errors.
 */
import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import { deleteEdition, deleteVideo, getEdition, getVideo, reindexEdition, updateEdition, updateVideo } from './store';
import type { VideoItem } from './types';
import { isVideoLocale } from './types';
import type { AddVideoInput } from './video-ingest-service';
import { pairEdition } from './video-ingest-service';
import { parseYoutubeId } from './youtube-url';

const MAX_TITLE = 300;
const MAX_DESCRIPTION = 5_000;

function optText(body: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new AppError(400, 'invalid_field', `"${key}" must be a string`);
  return v.trim().slice(0, max);
}

export function parseAddVideoInput(body: Record<string, unknown>): AddVideoInput {
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) throw new AppError(400, 'missing_url', '"url" (YouTube link) is required');
  const locale = body.locale ?? 'vi';
  if (!isVideoLocale(locale)) throw new AppError(400, 'invalid_locale', '"locale" must be "vi" or "en"');
  const pairWith = optText(body, 'pair_with', 200);
  return { url, locale, pair_with: pairWith || undefined, title: optText(body, 'title', MAX_TITLE) || undefined };
}

/** Resolves a reference to either a whole video (video id) or a single edition (YouTube link/id). */
async function resolveRef(db: D1DatabaseLike, ref: string): Promise<{ video: VideoItem; youtubeId: string | null }> {
  const youtubeId = parseYoutubeId(ref);
  if (youtubeId && (await getEdition(db, youtubeId))) {
    const video = await getVideo(db, youtubeId);
    if (video) return { video, youtubeId };
  }
  const video = await getVideo(db, ref);
  if (!video) throw new AppError(404, 'video_not_found', 'Video not found');
  return { video, youtubeId: null };
}

/**
 * Video fields: position, featured. Edition fields (when `ref` is a YouTube id/link): title,
 * description, locale, pair_with (move this edition under another video).
 */
export async function applyVideoPatch(db: D1DatabaseLike, ref: string, body: Record<string, unknown>): Promise<VideoItem> {
  const { video, youtubeId } = await resolveRef(db, ref);
  const position = body.position;
  if (position !== undefined && (typeof position !== 'number' || !Number.isFinite(position))) throw new AppError(400, 'invalid_field', '"position" must be a number');
  const featured = body.featured;
  if (featured !== undefined && typeof featured !== 'boolean') throw new AppError(400, 'invalid_field', '"featured" must be a boolean');
  await updateVideo(db, video.id, { position: typeof position === 'number' ? position : undefined, featured: typeof featured === 'boolean' ? featured : undefined });

  const title = optText(body, 'title', MAX_TITLE);
  const description = optText(body, 'description', MAX_DESCRIPTION);
  const locale = body.locale;
  const pairWith = optText(body, 'pair_with', 200);
  const editsEdition = title !== undefined || description !== undefined || locale !== undefined || Boolean(pairWith);
  if (editsEdition && !youtubeId) throw new AppError(400, 'edition_required', 'Use the YouTube id of the edition to edit title, description, locale or pair_with');
  if (youtubeId) {
    if (locale !== undefined && !isVideoLocale(locale)) throw new AppError(400, 'invalid_locale', '"locale" must be "vi" or "en"');
    if (isVideoLocale(locale) && video.editions.some(e => e.locale === locale && e.youtube_id !== youtubeId)) {
      throw new AppError(409, 'edition_exists', `This video already has a ${locale.toUpperCase()} edition`);
    }
    await updateEdition(db, youtubeId, { title: title || undefined, description, locale: isVideoLocale(locale) ? locale : undefined });
    if (title !== undefined || description !== undefined || locale !== undefined) await reindexEdition(db, youtubeId);
    if (pairWith) return pairEdition(db, youtubeId, pairWith);
  }
  const updated = await getVideo(db, video.id);
  if (!updated) throw new AppError(404, 'video_not_found', 'Video not found');
  return updated;
}

/** Deletes one edition (YouTube id/link) or the whole video (video id). */
export async function removeVideoOrEdition(db: D1DatabaseLike, ref: string): Promise<{ deleted: 'video' | 'edition'; id: string }> {
  const { video, youtubeId } = await resolveRef(db, ref);
  if (youtubeId) {
    await deleteEdition(db, youtubeId);
    return { deleted: 'edition', id: youtubeId };
  }
  await deleteVideo(db, video.id);
  return { deleted: 'video', id: video.id };
}
