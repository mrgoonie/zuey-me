/**
 * Time-bound value of PRESENCE_INTERNAL_HEADER, shared by the Pages client (signs) and the presence Worker
 * (verifies): `<unixSeconds>.<hmacBase64Url(secret, PRESENCE_INTERNAL_LABEL + ':' + METHOD + ':' + path + ':' + unixSeconds)>`.
 * The HMAC covers the HTTP method and URL path, so a value captured for one request is useless for another route or
 * verb. A captured value also stops working after PRESENCE_INTERNAL_MAX_SKEW_MS. No app imports so the Worker can bundle it.
 */
import { PRESENCE_INTERNAL_LABEL, PRESENCE_INTERNAL_MAX_SKEW_MS } from './contract';
import { hmacBase64Url } from './ticket';

/** Canonical seconds (no leading zero, up to 12 digits) `.` a 43-character base64url HMAC-SHA256. */
const INTERNAL_AUTH_PATTERN = /^([1-9]\d{0,11})\.([A-Za-z0-9_-]{43})$/;

const signature = (secret: string, method: string, path: string, seconds: number): Promise<string> =>
  hmacBase64Url(secret, `${PRESENCE_INTERNAL_LABEL}:${method.toUpperCase()}:${path}:${seconds}`);

/** Signs one request: `method` is the HTTP verb and `path` the URL pathname (no query or origin). */
export async function signPresenceInternal(secret: string, method: string, path: string, nowMs = Date.now()): Promise<string> {
  const seconds = Math.floor(nowMs / 1000);
  return `${seconds}.${await signature(secret, method, path, seconds)}`;
}

/**
 * True when `value` is well formed, its timestamp is within PRESENCE_INTERNAL_MAX_SKEW_MS of `nowMs` (either
 * direction) and its HMAC matches. Both digests are re-HMACed before comparing, so timing never reveals how
 * much of the expected value a caller guessed. `method` and `path` come from the request being authorised.
 */
export async function verifyPresenceInternal(
  secret: string, value: string | null, method: string, path: string, nowMs = Date.now(),
): Promise<boolean> {
  if (!secret || !value) return false;
  const m = INTERNAL_AUTH_PATTERN.exec(value);
  if (!m) return false;
  const seconds = Number(m[1]);
  if (Math.abs(nowMs - seconds * 1000) > PRESENCE_INTERNAL_MAX_SKEW_MS) return false;
  const expected = await signature(secret, method, path, seconds);
  const [a, b] = await Promise.all([
    hmacBase64Url(secret, `internal-compare:${m[2]}`),
    hmacBase64Url(secret, `internal-compare:${expected}`),
  ]);
  return a === b;
}
