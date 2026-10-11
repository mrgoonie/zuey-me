import { base64Url } from '../members/runtime';

/**
 * Account-link tokens signed by dewee (Channel Access Gate) and redeemed at `/connect?token=…`.
 *
 * Format: `base64url(JSON payload) + "." + base64url(HMAC-SHA256(CHANNEL_LINK_TOKEN_SECRET, payloadPart))`, where
 * `payloadPart` is the first segment exactly as transmitted and base64url has no padding. Payload:
 * `{ v: 1, channel_type, channel_instance, sender_id, sender_username?, tenant?, exp (unix seconds), nonce }`.
 * The signature is checked (constant time) before the payload is parsed; each nonce links at most once.
 */

export const LINK_TOKEN_VERSION = 1;
/** Channel types whose sender ids may be linked to a member account. */
export const SUPPORTED_CHANNEL_TYPES = ['telegram'] as const;
export type ChannelType = (typeof SUPPORTED_CHANNEL_TYPES)[number];
/** Longest accepted token; dewee tokens are a few hundred characters. */
export const MAX_LINK_TOKEN_LENGTH = 2048;
/** Tokens that claim to stay valid longer than this are rejected (dewee issues ~15-minute tokens). */
export const MAX_LINK_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

/** Sender ids are opaque platform ids (Telegram: digits); kept to a conservative charset. */
export const SENDER_ID_RE = /^[A-Za-z0-9_.:@+-]{1,128}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{8,128}$/;
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
/** Shape of a token, used before passing one through to a link URL. */
export const LINK_TOKEN_SHAPE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface LinkTokenPayload {
  v: typeof LINK_TOKEN_VERSION;
  channel_type: ChannelType;
  channel_instance: string;
  sender_id: string;
  sender_username: string | null;
  tenant: string | null;
  /** Expiry, unix seconds. */
  exp: number;
  nonce: string;
}

export type LinkTokenError = 'malformed' | 'bad_signature' | 'expired' | 'unsupported_channel' | 'unsupported_version';

export type LinkTokenResult = { ok: true; payload: LinkTokenPayload } | { ok: false; error: LinkTokenError };

export function isChannelType(v: unknown): v is ChannelType {
  return typeof v === 'string' && (SUPPORTED_CHANNEL_TYPES as readonly string[]).includes(v);
}

function base64UrlDecode(segment: string): Uint8Array<ArrayBuffer> | null {
  if (!SEGMENT_RE.test(segment)) return null;
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (segment.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function optionalText(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) return undefined;
  return v;
}

/** Validates the decoded JSON payload; returns the reason when it is unusable. */
function parsePayload(raw: unknown): LinkTokenPayload | LinkTokenError {
  if (!isRecord(raw)) return 'malformed';
  if (raw.v !== LINK_TOKEN_VERSION) return 'unsupported_version';
  if (!isChannelType(raw.channel_type)) return 'unsupported_channel';
  const instance = raw.channel_instance;
  const sender = raw.sender_id;
  const exp = raw.exp;
  const nonce = raw.nonce;
  const username = optionalText(raw.sender_username, 64);
  const tenant = optionalText(raw.tenant, 128);
  if (typeof instance !== 'string' || instance === '' || instance.length > 128) return 'malformed';
  if (typeof sender !== 'string' || !SENDER_ID_RE.test(sender)) return 'malformed';
  if (typeof exp !== 'number' || !Number.isSafeInteger(exp)) return 'malformed';
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return 'malformed';
  if (username === undefined || tenant === undefined) return 'malformed';
  return { v: LINK_TOKEN_VERSION, channel_type: raw.channel_type, channel_instance: instance, sender_id: sender, sender_username: username, tenant, exp, nonce };
}

/** Verifies signature, shape and expiry of a link token. Never throws. */
export async function verifyLinkToken(token: unknown, secret: string, nowMs: number): Promise<LinkTokenResult> {
  if (typeof token !== 'string' || token.length > MAX_LINK_TOKEN_LENGTH || !LINK_TOKEN_SHAPE_RE.test(token)) return { ok: false, error: 'malformed' };
  const [payloadPart, signaturePart] = token.split('.');
  const signature = base64UrlDecode(signaturePart);
  if (!signature || signature.length !== 32) return { ok: false, error: 'malformed' };
  // crypto.subtle.verify compares the MAC in constant time.
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), signature, new TextEncoder().encode(payloadPart));
  if (!valid) return { ok: false, error: 'bad_signature' };

  const bytes = base64UrlDecode(payloadPart);
  if (!bytes) return { ok: false, error: 'malformed' };
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, error: 'malformed' };
  }
  const payload = parsePayload(raw);
  if (typeof payload === 'string') return { ok: false, error: payload };
  const nowSec = Math.floor(nowMs / 1000);
  if (payload.exp <= nowSec) return { ok: false, error: 'expired' };
  if (payload.exp - nowSec > MAX_LINK_TOKEN_LIFETIME_SECONDS) return { ok: false, error: 'malformed' };
  return { ok: true, payload };
}

/** Signs a payload in the dewee token format (reference implementation, used by tests and for interop checks). */
export async function signLinkToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const payloadPart = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), new TextEncoder().encode(payloadPart));
  return `${payloadPart}.${base64Url(new Uint8Array(mac))}`;
}
