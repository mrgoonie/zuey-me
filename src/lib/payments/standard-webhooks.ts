/**
 * Standard Webhooks (https://standardwebhooks.com) signature scheme, used by Dodo Payments webhooks:
 * HMAC-SHA256 over `${webhook-id}.${webhook-timestamp}.${raw body}`, sent as space-separated `v1,<base64>`.
 * Implemented with crypto.subtle so it runs on the Cloudflare edge.
 */

/** Standard Webhooks libraries reject timestamps more than five minutes away from now (replay window). */
export const MAX_WEBHOOK_SKEW_SECONDS = 5 * 60;

export interface WebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/** Reads the three Standard Webhooks headers from a request. */
export function standardWebhookHeaders(request: Request): WebhookHeaders {
  return {
    id: request.headers.get('webhook-id'),
    timestamp: request.headers.get('webhook-timestamp'),
    signature: request.headers.get('webhook-signature'),
  };
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** HMAC key for a secret: `whsec_` + base64 key bytes (the prefix is optional); null when not base64. */
function signingKey(secret: string): Uint8Array<ArrayBuffer> | null {
  const decoded = base64ToBytes(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret);
  return decoded && decoded.length > 0 ? decoded : null;
}

/** Verifies a Standard Webhooks signature (constant-time HMAC verify) and the replay window. */
export async function verifyStandardWebhook(
  secret: string, headers: WebhookHeaders, body: string, nowMs: number
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowMs / 1000 - ts) > MAX_WEBHOOK_SKEW_SECONDS) return false;
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
  const signatures = signature
    .split(' ')
    .map(s => s.trim())
    .filter(s => s.startsWith('v1,'))
    .map(s => base64ToBytes(s.slice(3)))
    .filter((s): s is Uint8Array<ArrayBuffer> => s !== null);
  const keyBytes = signingKey(secret);
  if (signatures.length === 0 || !keyBytes) return false;
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  for (const sig of signatures) {
    if (await crypto.subtle.verify('HMAC', key, sig, signed)) return true;
  }
  return false;
}

/** Produces a `v1,<base64>` signature with the Standard Webhooks key derivation; used by tests and tooling. */
export async function signStandardWebhook(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const keyBytes = signingKey(secret);
  if (!keyBytes) throw new Error('Webhook secret must be whsec_ followed by base64 key bytes');
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  let bin = '';
  for (const b of mac) bin += String.fromCharCode(b);
  return `v1,${btoa(bin)}`;
}
