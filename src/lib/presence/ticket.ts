/**
 * Presence connect tickets: `base64url(payload JSON).base64url(HMAC-SHA256)` signed with
 * PRESENCE_TICKET_SECRET, shared by the Pages app (issues) and the presence Worker (verifies).
 * Web Crypto only, so it runs in both runtimes; no app imports so the Worker can bundle it.
 */
import { PRESENCE_TICKET_TTL_MS, type PresenceTicketPayload } from './contract';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const bin = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** HMAC-SHA256 of `value` as base64url; used for tickets and for opaque dedupe keys. */
export async function hmacBase64Url(secret: string, value: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(value));
  return toBase64Url(new Uint8Array(sig));
}

export async function signPresenceTicket(secret: string, payload: PresenceTicketPayload): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await hmacBase64Url(secret, body)}`;
}

function isPayload(v: unknown): v is PresenceTicketPayload {
  if (typeof v !== 'object' || v === null) return false;
  return 'k' in v && typeof v.k === 'string' && v.k.length > 0 && v.k.length <= 64
    && 'c' in v && typeof v.c === 'boolean'
    && 'm' in v && typeof v.m === 'boolean'
    && 'o' in v && typeof v.o === 'boolean'
    && 'exp' in v && typeof v.exp === 'number'
    && 'n' in v && typeof v.n === 'string' && v.n.length <= 64;
}

/**
 * Returns the payload when the signature is valid and the ticket is unexpired (and not issued
 * further ahead than one TTL), else null. Constant-time comparison via `crypto.subtle.verify`.
 */
export async function verifyPresenceTicket(secret: string, ticket: string, now = Date.now()): Promise<PresenceTicketPayload | null> {
  if (!secret || typeof ticket !== 'string' || ticket.length > 1024) return null;
  const [body, sig, extra] = ticket.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const sigBytes = fromBase64Url(sig);
  const bodyBytes = fromBase64Url(body);
  if (!sigBytes || !bodyBytes) return null;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sigBytes, encoder.encode(body));
  if (!ok) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bodyBytes));
  } catch {
    return null;
  }
  if (!isPayload(parsed)) return null;
  if (parsed.exp <= now || parsed.exp > now + PRESENCE_TICKET_TTL_MS + 5_000) return null;
  return parsed;
}
