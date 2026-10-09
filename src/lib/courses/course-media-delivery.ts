/**
 * Streams a private R2 course file for a signed, unexpired token. Tokens are bound to the viewer
 * who requested them, so a copied link does not play for another account. Supports HTTP Range
 * for audio seeking and resumable downloads.
 */
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { Principal } from '../members/policy';
import { getAsset } from './course-asset-store';
import { ANONYMOUS_VIEWER, verifyFileToken } from './course-media-signing';

function parseRange(header: string | null, size: number): { offset: number; length: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid';
  return { offset: start, length: end - start + 1 };
}

function contentDisposition(name: string, download: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function serveCourseFile(d1: D1DatabaseLike, env: RuntimeEnv, principal: Principal, token: string, request: Request): Promise<Response> {
  const claim = await verifyFileToken(env, token);
  if (!claim) throw new AppError(403, 'media_link_expired', 'This media link is invalid or expired; reload the lesson');
  if (claim.viewer !== ANONYMOUS_VIEWER && principal.kind !== 'admin' && principal.userId !== claim.viewer) {
    throw new AppError(403, 'media_link_not_yours', 'This media link belongs to another account');
  }
  const asset = await getAsset(d1, claim.assetId);
  if (!asset || asset.provider !== 'r2') throw new AppError(404, 'asset_not_found', 'Media not found');
  if (!env.COURSE_FILES) throw new AppError(503, 'media_unconfigured', 'Course file storage is not configured');
  const size = asset.size_bytes ?? 0;
  const range = size > 0 ? parseRange(request.headers.get('range'), size) : null;
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const object = await env.COURSE_FILES.get(asset.ref, range ? { range } : undefined);
  if (!object) throw new AppError(404, 'asset_not_found', 'Media file is missing from storage');
  const headers = new Headers({
    'Content-Type': asset.mime || object.httpMetadata?.contentType || 'application/octet-stream',
    'Content-Disposition': contentDisposition(asset.name, asset.kind === 'file' || new URL(request.url).searchParams.has('download')),
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
  });
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
    headers.set('Content-Length', String(range.length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { status: 200, headers });
}
