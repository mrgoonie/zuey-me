/** Private course media records: Stream video UIDs pasted by the admin and files uploaded to R2. */
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { Row } from '../members/runtime';
import { iso, membersRuntime, randomId } from '../members/runtime';
import type { AssetRecord, CourseRecord } from './course-types';
import { optionalText, requiredText, rowToAsset } from './course-types';
import { parseStoredLesson, referencedAssetIds } from './lesson-blocks';

/** Largest single upload through the app (Workers request body limit on the paid plan is 100 MB). */
export const MAX_UPLOAD_BYTES = 95 * 1024 * 1024;
const STREAM_UID_RE = /^[a-f0-9]{32}$/;

export async function listAssets(d1: D1DatabaseLike, courseId: string): Promise<AssetRecord[]> {
  const { results } = await d1.prepare('SELECT * FROM course_assets WHERE course_id = ? ORDER BY created_at DESC').bind(courseId).all<Row>();
  return (results ?? []).map(rowToAsset);
}

export async function getAsset(d1: D1DatabaseLike, id: string): Promise<AssetRecord | null> {
  const row = await d1.prepare('SELECT * FROM course_assets WHERE id = ?').bind(id).first<Row>();
  return row ? rowToAsset(row) : null;
}

function optionalInt(body: Record<string, unknown>, key: string): number | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new AppError(400, 'invalid_field', `${key} must be a non-negative integer`, { field: key });
  return v;
}

async function insertAsset(d1: D1DatabaseLike, a: Omit<AssetRecord, 'created_at'>): Promise<AssetRecord> {
  await d1.prepare(
    'INSERT INTO course_assets (id, course_id, kind, provider, ref, name, mime, size_bytes, duration_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(a.id, a.course_id, a.kind, a.provider, a.ref, a.name, a.mime, a.size_bytes, a.duration_seconds, iso(membersRuntime.now())).run();
  const asset = await getAsset(d1, a.id);
  if (!asset) throw new AppError(500, 'internal_error', 'Asset was not persisted');
  return asset;
}

/** Registers a Cloudflare Stream video (uploaded in the Stream dashboard with "require signed URLs"). */
export async function createStreamAsset(d1: D1DatabaseLike, course: CourseRecord, body: Record<string, unknown>): Promise<AssetRecord> {
  const uid = requiredText(body, 'stream_uid', 64).toLowerCase();
  if (!STREAM_UID_RE.test(uid)) throw new AppError(400, 'invalid_field', 'stream_uid must be the 32-character Stream video id', { field: 'stream_uid' });
  return insertAsset(d1, {
    id: randomId('ast'), course_id: course.id, kind: 'video', provider: 'stream', ref: uid,
    name: requiredText(body, 'name', 200), mime: null, size_bytes: null, duration_seconds: optionalInt(body, 'duration_seconds'),
  });
}

function safeFileName(name: string): string {
  return name.normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').slice(-120) || 'file';
}

/** Stores an uploaded audio/file in the private R2 bucket and records it. */
export async function uploadR2Asset(
  d1: D1DatabaseLike, env: RuntimeEnv, course: CourseRecord,
  input: { file: File; kind: unknown; name?: string; durationSeconds?: number | null },
): Promise<AssetRecord> {
  if (!env.COURSE_FILES) throw new AppError(503, 'media_unconfigured', 'Course file storage is not configured: missing COURSE_FILES (R2 binding)', { missing: ['COURSE_FILES'] });
  if (input.kind !== 'audio' && input.kind !== 'file') throw new AppError(400, 'invalid_field', "kind must be 'audio' or 'file'", { field: 'kind' });
  if (input.file.size === 0 || input.file.size > MAX_UPLOAD_BYTES) {
    throw new AppError(413, 'file_too_large', `Files must be 1 byte to ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
  }
  const id = randomId('ast');
  const key = `courses/${course.id}/${id}/${safeFileName(input.file.name)}`;
  const mime = input.file.type || 'application/octet-stream';
  await env.COURSE_FILES.put(key, input.file.stream(), { httpMetadata: { contentType: mime } });
  return insertAsset(d1, {
    id, course_id: course.id, kind: input.kind, provider: 'r2', ref: key,
    name: (input.name ?? '').trim().slice(0, 200) || input.file.name.slice(0, 200), mime, size_bytes: input.file.size,
    duration_seconds: input.durationSeconds ?? null,
  });
}

export async function updateAsset(d1: D1DatabaseLike, course: CourseRecord, id: string, body: Record<string, unknown>): Promise<AssetRecord> {
  const asset = await getAsset(d1, id);
  if (!asset || asset.course_id !== course.id) throw new AppError(404, 'asset_not_found', 'Asset not found');
  const name = optionalText(body, 'name', 200) || asset.name;
  const duration = body.duration_seconds !== undefined ? optionalInt(body, 'duration_seconds') : asset.duration_seconds;
  await d1.prepare('UPDATE course_assets SET name = ?, duration_seconds = ? WHERE id = ?').bind(name, duration, asset.id).run();
  return (await getAsset(d1, asset.id)) ?? asset;
}

/** Deletes the record (and the R2 object). Stream videos are deleted in the Stream dashboard. */
/** Lessons of the course whose draft or published document still references the asset. */
async function lessonsUsingAsset(d1: D1DatabaseLike, courseId: string, assetId: string): Promise<string[]> {
  const { results } = await d1.prepare('SELECT slug, draft_json, published_json FROM course_lessons WHERE course_id = ?').bind(courseId).all<Row>();
  return (results ?? []).filter(r => [r.draft_json, r.published_json].some(json => {
    const doc = typeof json === 'string' ? parseStoredLesson(json) : null;
    return doc ? referencedAssetIds(doc).includes(assetId) : false;
  })).map(r => String(r.slug));
}

export async function deleteAsset(d1: D1DatabaseLike, env: RuntimeEnv, course: CourseRecord, id: string): Promise<{ deleted: true }> {
  const asset = await getAsset(d1, id);
  if (!asset || asset.course_id !== course.id) throw new AppError(404, 'asset_not_found', 'Asset not found');
  const usedBy = await lessonsUsingAsset(d1, course.id, asset.id);
  if (usedBy.length) {
    throw new AppError(409, 'asset_in_use', `Remove this media from ${usedBy.length} lesson(s) (draft or published) before deleting it`, { lessons: usedBy });
  }
  if (asset.provider === 'r2' && env.COURSE_FILES) await env.COURSE_FILES.delete(asset.ref);
  await d1.prepare('DELETE FROM course_assets WHERE id = ?').bind(asset.id).run();
  return { deleted: true };
}
