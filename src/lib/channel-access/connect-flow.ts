import type { LinkPreviewState } from './identities';
import { MAX_LINK_TOKEN_LENGTH } from './link-token';

/**
 * /connect keeps the dewee link token out of every URL that page analytics, history or a Referer could see:
 * `/connect?token=…` only stores the token in this HttpOnly cookie and redirects to the bare `/connect`, the
 * login round-trip uses `next=/connect`, and the cookie is cleared once the token is spent or unusable.
 */
export const CONNECT_PATH = '/connect';
/** Sign-in round-trip: the token is already in the cookie, so `next` never carries it. */
export const CONNECT_LOGIN_REDIRECT = `/login?next=${encodeURIComponent(CONNECT_PATH)}`;
export const LINK_TOKEN_COOKIE = 'zuey_channel_link';
export const LINK_TOKEN_COOKIE_PATH = CONNECT_PATH;
/** Long enough to sign in by magic link; the token's own `exp` still applies. */
export const LINK_TOKEN_COOKIE_MAX_AGE = 30 * 60;

export const LINK_TOKEN_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: LINK_TOKEN_COOKIE_PATH,
  maxAge: LINK_TOKEN_COOKIE_MAX_AGE,
} as const;

/** `Set-Cookie` value that removes the token cookie (sent by the link API, whose path differs from /connect). */
export const CLEAR_LINK_TOKEN_COOKIE = `${LINK_TOKEN_COOKIE}=; Path=${LINK_TOKEN_COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

/** Error codes after which the token can never succeed, so the cookie holding it is dropped. */
const SPENT_TOKEN_ERRORS: ReadonlySet<string> = new Set([
  'invalid_link_token', 'link_token_expired', 'unsupported_channel', 'link_token_used', 'channel_linked_elsewhere',
]);

/** Whether a link error means the stored token is spent or unusable (configuration and outage errors keep it). */
export function isSpentTokenError(code: string | null): boolean {
  return code !== null && SPENT_TOKEN_ERRORS.has(code);
}

/** Whether /connect should keep the token cookie after rendering this state: only while a link is still possible. */
export function keepLinkTokenCookie(state: LinkPreviewState | 'error', errorCode: string | null): boolean {
  if (state === 'error') return !isSpentTokenError(errorCode);
  return state === 'ready';
}

export type ConnectEntry =
  /** `?token=` was present: store `token` in the cookie (or clear it when null) and redirect to the bare /connect. */
  | { kind: 'park'; token: string | null }
  /** Render /connect with the token from the cookie (null when there is none or it is unusable). */
  | { kind: 'continue'; token: string | null };

function usableToken(raw: string | null): string | null {
  return raw && raw.length <= MAX_LINK_TOKEN_LENGTH ? raw : null;
}

/** First step of /connect: a token in the query string is only ever parked in the cookie, never rendered. */
export function connectEntry(url: URL, cookieToken: string | null): ConnectEntry {
  if (url.searchParams.has('token')) return { kind: 'park', token: usableToken(url.searchParams.get('token')) };
  return { kind: 'continue', token: usableToken(cookieToken) };
}
