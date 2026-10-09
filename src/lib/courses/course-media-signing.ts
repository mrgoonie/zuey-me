/**
 * Short-lived media URLs for private course media.
 * - Cloudflare Stream: RS256 signed playback token (JWT) made with WebCrypto from the Stream signing key.
 * - R2 (audio, files): HMAC token served by our own route, bound to the viewer's account.
 * Tokens live 10 minutes, or the media duration plus 10 minutes so long videos can finish (max 4 hours).
 */
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { base64Url, membersRuntime, siteUrl } from '../members/runtime';
import type { AssetRecord } from './course-types';

export const MEDIA_TOKEN_MIN_TTL_SECONDS = 10 * 60;
const MEDIA_TOKEN_MAX_TTL_SECONDS = 4 * 60 * 60;
/** Viewer binding used for trial-lesson media opened without an account. */
export const ANONYMOUS_VIEWER = 'anon';

export function mediaTtlSeconds(asset: Pick<AssetRecord, 'duration_seconds'>): number {
  const d = asset.duration_seconds ?? 0;
  return Math.min(MEDIA_TOKEN_MAX_TTL_SECONDS, Math.max(MEDIA_TOKEN_MIN_TTL_SECONDS, d + MEDIA_TOKEN_MIN_TTL_SECONDS));
}

const enc = new TextEncoder();

function base64UrlString(text: string): string {
  return base64Url(enc.encode(text));
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

export function missingStreamConfig(env: RuntimeEnv): string[] {
  const missing: string[] = [];
  if (!env.CF_STREAM_CUSTOMER_CODE) missing.push('CF_STREAM_CUSTOMER_CODE');
  if (!env.CF_STREAM_SIGNING_KEY_ID) missing.push('CF_STREAM_SIGNING_KEY_ID');
  if (!env.CF_STREAM_SIGNING_JWK) missing.push('CF_STREAM_SIGNING_JWK');
  return missing;
}

/** Accepts the JWK as JSON or as the base64 string Cloudflare returns in `jwk`. */
function parseJwk(raw: string): JsonWebKey {
  const text = raw.trim().startsWith('{') ? raw : new TextDecoder().decode(fromBase64Url(raw.trim()));
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') throw new Error('JWK is not an object');
  return parsed as JsonWebKey;
}

/** Signed Stream playback token for one video UID, valid `ttlSeconds`. */
export async function signStreamToken(env: RuntimeEnv, videoUid: string, ttlSeconds: number): Promise<string> {
  const missing = missingStreamConfig(env);
  if (missing.length) throw new AppError(503, 'media_unconfigured', `Cloudflare Stream signing is not configured: missing ${missing.join(', ')}`, { missing });
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('jwk', parseJwk(env.CF_STREAM_SIGNING_JWK ?? ''), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    throw new AppError(503, 'media_unconfigured', 'CF_STREAM_SIGNING_JWK is not a valid RSA private key');
  }
  const now = Math.floor(membersRuntime.now() / 1000);
  const header = base64UrlString(JSON.stringify({ alg: 'RS256', kid: env.CF_STREAM_SIGNING_KEY_ID }));
  const payload = base64UrlString(JSON.stringify({ sub: videoUid, kid: env.CF_STREAM_SIGNING_KEY_ID, exp: now + ttlSeconds, nbf: now - 60 }));
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

export function streamIframeUrl(env: RuntimeEnv, token: string): string {
  return `https://customer-${env.CF_STREAM_CUSTOMER_CODE}.cloudflarestream.com/${token}/iframe`;
}

interface FileTokenPayload { a: string; u: string; e: number }

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function requireMediaSecret(env: RuntimeEnv): string {
  if (!env.COURSE_MEDIA_SECRET) {
    throw new AppError(503, 'media_unconfigured', 'Course media is not configured: missing COURSE_MEDIA_SECRET', { missing: ['COURSE_MEDIA_SECRET'] });
  }
  return env.COURSE_MEDIA_SECRET;
}

/** `<payload>.<hmac>` for one R2 asset and viewer (user id or ANONYMOUS_VIEWER). */
export async function signFileToken(env: RuntimeEnv, assetId: string, viewer: string, ttlSeconds: number): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Math.floor(membersRuntime.now() / 1000) + ttlSeconds;
  const payload = base64UrlString(JSON.stringify({ a: assetId, u: viewer, e: expiresAt } satisfies FileTokenPayload));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(requireMediaSecret(env)), enc.encode(payload));
  return { token: `${payload}.${base64Url(new Uint8Array(sig))}`, expiresAt };
}

/** Verifies signature and expiry; null when the token is forged, malformed or expired. */
export async function verifyFileToken(env: RuntimeEnv, token: string): Promise<{ assetId: string; viewer: string } | null> {
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined || token.length > 1_000) return null;
  let valid = false;
  try {
    valid = await crypto.subtle.verify('HMAC', await hmacKey(requireMediaSecret(env)), fromBase64Url(sig), enc.encode(payload));
  } catch {
    return null;
  }
  if (!valid) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as Partial<FileTokenPayload>;
    if (typeof p.a !== 'string' || typeof p.u !== 'string' || typeof p.e !== 'number') return null;
    if (p.e * 1000 < membersRuntime.now()) return null;
    return { assetId: p.a, viewer: p.u };
  } catch {
    return null;
  }
}

export interface SignedMedia {
  asset_id: string;
  kind: AssetRecord['kind'];
  name: string;
  mime: string | null;
  size_bytes: number | null;
  /** Stream iframe URL (video) or our file URL (audio/file). */
  url: string;
  expires_at: string;
}

/** Signs a playable/downloadable URL for an asset the caller is already allowed to see. */
export async function signAssetUrl(env: RuntimeEnv, asset: AssetRecord, viewer: string): Promise<SignedMedia> {
  const ttl = mediaTtlSeconds(asset);
  const base = { asset_id: asset.id, kind: asset.kind, name: asset.name, mime: asset.mime, size_bytes: asset.size_bytes };
  if (asset.provider === 'stream') {
    const token = await signStreamToken(env, asset.ref, ttl);
    return { ...base, url: streamIframeUrl(env, token), expires_at: new Date(membersRuntime.now() + ttl * 1000).toISOString() };
  }
  const { token, expiresAt } = await signFileToken(env, asset.id, viewer, ttl);
  return { ...base, url: `${siteUrl(env)}/api/v1/courses/media/${token}`, expires_at: new Date(expiresAt * 1000).toISOString() };
}
