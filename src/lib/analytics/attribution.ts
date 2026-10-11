/**
 * Session attribution: the campaign (UTM) parameters and referring site of the page that opened this
 * browser session, kept in sessionStorage and attached to every client event as `session_*` properties.
 *
 * Only an allowlist survives: the five standard `utm_*` keys with short, plain values, and the referrer's
 * origin. The referrer's path and query are dropped because they routinely carry search terms, private
 * document or webmail ids and sign-in tokens; the origin is enough to tell the channel apart.
 */
import { containsPii } from './pii';

/** sessionStorage key: one entry per tab session, written on the first tracked page of the session. */
export const ATTRIBUTION_STORAGE_KEY = 'zuey_analytics_attribution';

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
type UtmKey = (typeof UTM_KEYS)[number];

export type Attribution = Partial<Record<UtmKey, string>> & { referrer?: string };

/** Letters (any script), digits, spaces and a few separators; nothing that can carry a URL, address or query. */
const UTM_VALUE_RE = /^[\p{L}\p{N} ._+|:()-]{1,100}$/u;

function cleanUtm(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (!UTM_VALUE_RE.test(value) || containsPii(value)) return null;
  return value;
}

/** Origin of an external http(s) referrer; null for none, for this site itself, or for anything else. */
export function referrerOrigin(referrer: string, ownHostname: string): string | null {
  if (!referrer) return null;
  try {
    const url = new URL(referrer);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.hostname.toLowerCase() === ownHostname.toLowerCase()) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Attribution of a landing page: allowlisted UTM values from its query and the external referrer origin. */
export function parseAttribution(search: string, referrer: string, ownHostname: string): Attribution {
  const out: Attribution = {};
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    params = new URLSearchParams();
  }
  for (const key of UTM_KEYS) {
    const value = cleanUtm(params.get(key));
    if (value !== null) out[key] = value;
  }
  const origin = referrerOrigin(referrer, ownHostname);
  if (origin !== null) out.referrer = origin;
  return out;
}

/** Reads a stored entry back, keeping only allowlisted, still-valid values. */
export function parseStoredAttribution(raw: string | null): Attribution | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const out: Attribution = {};
    for (const key of UTM_KEYS) {
      const value = key in parsed ? Reflect.get(parsed, key) : undefined;
      const clean = typeof value === 'string' ? cleanUtm(value) : null;
      if (clean !== null) out[key] = clean;
    }
    const ref = 'referrer' in parsed ? parsed.referrer : undefined;
    if (typeof ref === 'string') {
      const origin = referrerOrigin(ref, '');
      if (origin !== null && origin === ref) out.referrer = origin;
    }
    return out;
  } catch {
    return null;
  }
}

/** Event properties for an attribution: `session_utm_source`, …, `session_referrer`. */
export function attributionProperties(a: Attribution | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!a) return out;
  for (const key of UTM_KEYS) {
    const value = a[key];
    if (value !== undefined) out[`session_${key}`] = value;
  }
  if (a.referrer !== undefined) out.session_referrer = a.referrer;
  return out;
}
