/**
 * PII guard shared by the client (`before_send`) and the server capture path. Pure functions with no
 * browser or runtime dependency so the same rules run everywhere and stay unit-testable.
 */

export const REDACTED = '[redacted]';

/** Query/fragment parameters removed from every URL before it is sent (compared lower-case). */
const SENSITIVE_PARAMS = new Set([
  'token', 'code', 'email', 'key', 'secret', 'sig', 'signature', 'state', 'session', 'password', 'pass', 'pwd',
  'auth', 'otp', 'api_key', 'apikey', 'access_token', 'refresh_token', 'id_token', 'client_secret',
  'confirm_email', 'new_email', 'jwt', 'hmac', 'nonce', 'ticket', 'manage', 'payerid',
]);
/** Any parameter whose name contains one of these fragments is also removed (e.g. `reset_token`). */
const SENSITIVE_FRAGMENTS = ['token', 'secret', 'password', 'email', 'session', 'signature'];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
/** zuey.me member sessions (`zm_`), OAuth tokens (`zoa_`/`zor_`), API keys (`zk_`), and common provider secrets. */
const SECRET_RE = /\b(?:zm|zoa|zor|zk|sk|rk|whsec|ghp|gho|github_pat|xox[abpr])_[A-Za-z0-9_-]{12,}/g;
/** `name=value` pairs of sensitive parameters embedded in free text such as autocapture's `$elements_chain`. */
const INLINE_PARAM_RE = /([?&#;]\s*)([A-Za-z0-9_.-]+)=([^&#\s"'<>]*)/g;

/**
 * Paths whose pages show account, billing, booking or AI data, or link a chat account (`/connect`). Their
 * URLs lose the whole query string and fragment (booking manage tokens, PayPal return parameters, link tokens)
 * and autocapture is off there.
 */
const SENSITIVE_PATH_RE = /^\/(?:account|login|billing|booking|chat|connect|oauth|studio|courses\/orders)(?:\/|$)/;

export function isSensitivePath(pathname: string): boolean {
  return SENSITIVE_PATH_RE.test(pathname);
}

/**
 * Order codes and booking ids in paths are replaced by placeholders: the order code is also the SePay
 * transfer memo, which is never sent to analytics.
 */
const PATH_TEMPLATES: ReadonlyArray<[RegExp, string]> = [
  [/(\/billing\/card\/)[A-Za-z0-9_-]+/g, '$1:id'],
  [/(\/billing\/)(?!card\/|card$|:)[A-Za-z0-9_-]+/g, '$1:code'],
  [/(\/courses\/orders\/)[A-Za-z0-9_-]+/g, '$1:code'],
  [/(\/booking\/)(?!:)[A-Za-z0-9_-]+/g, '$1:id'],
];

/** True when a path carries an order code or booking id (its page title may name the order too). */
export function hasPrivateIdentifier(pathname: string): boolean {
  return /^\/(?:billing|courses\/orders|booking)\/[^/]/.test(pathname);
}

export function templatePaths(value: string): string {
  let out = value;
  for (const [re, replacement] of PATH_TEMPLATES) out = out.replace(re, replacement);
  return out;
}

export function isSensitiveParam(name: string): boolean {
  const n = name.toLowerCase();
  if (SENSITIVE_PARAMS.has(n)) return true;
  return SENSITIVE_FRAGMENTS.some(f => n.includes(f));
}

function test(re: RegExp, value: string): boolean {
  re.lastIndex = 0;
  const hit = re.test(value);
  re.lastIndex = 0;
  return hit;
}

export function looksLikeEmail(value: string): boolean {
  return test(EMAIL_RE, value);
}

export function looksLikeJwt(value: string): boolean {
  return test(JWT_RE, value);
}

/** True when a string carries an email address, a JWT or a recognisable secret token. */
export function containsPii(value: string): boolean {
  return looksLikeEmail(value) || looksLikeJwt(value) || test(SECRET_RE, value);
}

function scrubParams(params: URLSearchParams): boolean {
  let changed = false;
  for (const name of [...new Set(params.keys())]) {
    if (isSensitiveParam(name)) {
      params.delete(name);
      changed = true;
    }
  }
  return changed;
}

/**
 * Removes sensitive query parameters (and fragment parameters such as `#access_token=`) from an
 * absolute or root-relative URL. Values that do not parse as a URL go through `redactString` instead.
 */
export function scrubUrl(input: string): string {
  const relative = input.startsWith('/') && !input.startsWith('//');
  const absolute = /^https?:\/\//i.test(input);
  if (!relative && !absolute) return redactString(input);
  let parsed: URL;
  try {
    parsed = new URL(input, 'https://relative.invalid');
  } catch {
    return redactString(input);
  }
  if (isSensitivePath(parsed.pathname)) {
    parsed.search = '';
    parsed.hash = '';
  }
  scrubParams(parsed.searchParams);
  if (parsed.hash.includes('=')) {
    const hashParams = new URLSearchParams(parsed.hash.slice(1));
    if (scrubParams(hashParams)) {
      const rest = hashParams.toString();
      parsed.hash = rest ? `#${rest}` : '';
    }
  }
  if (parsed.username || parsed.password) {
    parsed.username = '';
    parsed.password = '';
  }
  const out = relative ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString();
  return redactString(out);
}

/**
 * Replaces emails, JWTs, secret tokens, sensitive `name=value` pairs, order codes and booking ids in
 * paths inside arbitrary text.
 */
export function redactString(value: string): string {
  return templatePaths(value)
    .replace(INLINE_PARAM_RE, (match: string, lead: string, name: string) => (isSensitiveParam(name) ? `${lead}${name}=${REDACTED}` : match))
    .replace(JWT_RE, REDACTED)
    .replace(SECRET_RE, REDACTED)
    .replace(EMAIL_RE, REDACTED);
}

function scrubString(value: string): string {
  return /^(?:https?:\/\/|\/(?!\/))/i.test(value) ? scrubUrl(value) : redactString(value);
}

const MAX_DEPTH = 6;

/**
 * Deep-scrubs an arbitrary property bag (PostHog's automatic properties, `$set`, `$elements`):
 * URLs lose sensitive parameters and every string is redacted. Returns a new value; input untouched.
 */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => scrubValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = scrubValue(item, depth + 1);
  return out;
}
