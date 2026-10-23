/**
 * PII guard shared by the client (`before_send`) and the server capture path. Pure functions with no
 * browser or runtime dependency so the same rules run everywhere and stay unit-testable.
 */
import { PRODUCTION_HOSTNAMES } from './constants';

export const REDACTED = '[redacted]';

/** Query/fragment parameters removed from every URL before it is sent (compared lower-case). */
const SENSITIVE_PARAMS = new Set([
  'token', 'code', 'email', 'key', 'secret', 'sig', 'signature', 'state', 'session', 'password', 'pass', 'pwd',
  'auth', 'otp', 'api_key', 'apikey', 'access_token', 'refresh_token', 'id_token', 'client_secret',
  'confirm_email', 'new_email', 'jwt', 'hmac', 'nonce', 'ticket', 'manage', 'payerid',
]);
/** Any parameter whose name contains one of these fragments is also removed (e.g. `reset_token`). */
const SENSITIVE_FRAGMENTS = ['token', 'secret', 'password', 'email', 'session', 'signature'];
/**
 * Free-text search parameters read by the site's own pages (`/articles?q=`). They are removed from zuey.me
 * addresses (root-relative or on a production hostname); other sites' URLs keep theirs. Inside free text,
 * where the host is unknown, their value is redacted.
 */
const SEARCH_PARAMS = new Set(['q']);

function isSearchParam(name: string): boolean {
  return SEARCH_PARAMS.has(name.toLowerCase());
}

/**
 * Emails are `local@domain.tld` within RFC 5321 limits (64-char local part, 253-char domain, 63-char label).
 * Letters, marks and digits from any script are allowed so Unicode (IDN) addresses such as `user@bücher.example`
 * match. The scan starts at each `@` (`EMAIL_DOMAIN_RE`) and walks back over at most 64 local-part characters,
 * so it never restarts at every character: a regex that began with the local part did, which is slow on long
 * non-ASCII text in V8.
 */
const EMAIL_DOMAIN_RE = /@[\p{L}\p{M}\p{N}.-]{1,253}\.[\p{L}\p{M}]{2,63}/gu;
const EMAIL_LOCAL_CHAR_RE = /^[\p{L}\p{M}\p{N}._%+-]$/u;
const MAX_EMAIL_LOCAL_LENGTH = 64;
/** A run of base64url characters and dots: the only text a JWT (`eyJ….….…`) can span. */
const TOKEN_RUN_RE = /[A-Za-z0-9_.-]+/g;

/**
 * Replaces JWTs inside one token run: a dot-separated part holding `eyJ` plus at least 4 more characters,
 * followed by two parts of at least 4 characters. It matches what `eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}` would,
 * including a token glued to other text (`%20eyJ…`), but scans each run once. The regex restarted at every
 * `eyJ` in a long run, which made crafted input quadratic.
 */
function redactJwtRun(run: string): string {
  if (!run.includes('eyJ')) return run;
  const parts = run.split('.');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    const start = part.indexOf('eyJ');
    const isJwt = start >= 0 && part.length - start >= 7 && (parts[i + 1]?.length ?? 0) >= 4 && (parts[i + 2]?.length ?? 0) >= 4;
    if (isJwt) {
      out.push(`${part.slice(0, start)}${REDACTED}`);
      i += 2;
    } else {
      out.push(part);
    }
  }
  return out.join('.');
}

function redactJwts(value: string): string {
  return value.includes('eyJ') ? value.replace(TOKEN_RUN_RE, redactJwtRun) : value;
}
/** zuey.me member sessions (`zm_`), OAuth tokens (`zoa_`/`zor_`), API keys (`zk_`), and common provider secrets. */
const SECRET_RE = /\b(?:zm|zoa|zor|zk|sk|rk|whsec|ghp|gho|github_pat|xox[abpr])_[A-Za-z0-9_-]{12,}/g;
/** `name=value` pairs of sensitive parameters embedded in free text such as autocapture's `$elements_chain` or an `$elements` href. */
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

/** The code point ending just before `index` (a surrogate pair counts as one character). */
function charBefore(value: string, index: number): string {
  const low = value.charCodeAt(index - 1);
  const pair = index >= 2 && low >= 0xdc00 && low <= 0xdfff;
  return value.slice(pair ? index - 2 : index - 1, index);
}

/** `[start, end)` of every email, left to right and non-overlapping. */
function emailRanges(value: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  if (!value.includes('@')) return ranges;
  let floor = 0;
  EMAIL_DOMAIN_RE.lastIndex = 0;
  let match = EMAIL_DOMAIN_RE.exec(value);
  while (match !== null) {
    const at = match.index;
    let start = at;
    for (let length = 0; length < MAX_EMAIL_LOCAL_LENGTH && start > floor; length++) {
      const char = charBefore(value, start);
      if (!EMAIL_LOCAL_CHAR_RE.test(char)) break;
      start -= char.length;
    }
    if (start === at) {
      EMAIL_DOMAIN_RE.lastIndex = at + 1;
    } else {
      floor = at + match[0].length;
      ranges.push([start, floor]);
    }
    match = EMAIL_DOMAIN_RE.exec(value);
  }
  EMAIL_DOMAIN_RE.lastIndex = 0;
  return ranges;
}

function hasEmail(value: string): boolean {
  return emailRanges(value).length > 0;
}

function redactEmails(value: string): string {
  const ranges = emailRanges(value);
  if (ranges.length === 0) return value;
  let out = '';
  let last = 0;
  for (const [start, end] of ranges) {
    out += `${value.slice(last, start)}${REDACTED}`;
    last = end;
  }
  return out + value.slice(last);
}

function test(re: RegExp, value: string): boolean {
  re.lastIndex = 0;
  const hit = re.test(value);
  re.lastIndex = 0;
  return hit;
}

/** A run of characters between URL delimiters (query/fragment separators, path slashes, whitespace, quotes). */
const SEGMENT_RE = /[^\s&#?=;/"'<>]+/g;
const SEGMENT_DELIMITER_RE = /[\s&#?=;/"'<>]/;

/**
 * Longest string the scrubber inspects. Real URLs, referrers and autocapture element chains stay far below
 * it; anything longer is cut so a crafted value cannot stall the visitor's tab on every capture.
 */
export const MAX_SCRUB_LENGTH = 16_384;

/**
 * Cuts a string to `MAX_SCRUB_LENGTH` and replaces the rest with `[redacted]`. The cut falls back to the
 * last URL delimiter so a half-cut email, JWT or token never survives as a fragment the patterns miss.
 */
function capLength(value: string): string {
  if (value.length <= MAX_SCRUB_LENGTH) return value;
  let end = MAX_SCRUB_LENGTH;
  while (end > 0 && !SEGMENT_DELIMITER_RE.test(value.charAt(end - 1))) end--;
  return `${value.slice(0, end)}${REDACTED}`;
}
/** Percent-decoding passes before a value that still decodes further is treated as hiding something. */
const MAX_DECODE_PASSES = 8;
const ESCAPE_RUN_RE = /(?:%[0-9A-Fa-f]{2})+/g;
const ASCII_ESCAPE_RE = /%([0-7][0-9A-Fa-f])/g;
/** Characters a redacted segment keeps as they are: unreserved ones plus those that never split a URL. */
const SEGMENT_UNSAFE_RE = /[^A-Za-z0-9._~+\-:@!$*,()]/gu;
const NON_ASCII_RE = /[^\x00-\x7F]/;

/**
 * One percent-decoding pass. Each run of escapes is decoded as UTF-8 (`b%C3%BCcher`, `h%E1%BB%8Dc`); a run
 * that is not valid UTF-8 keeps its non-ASCII escapes and only has its ASCII ones (`%40`) decoded, so this
 * never throws.
 */
function decodeOnce(value: string): string {
  return value.replace(ESCAPE_RUN_RE, (run: string) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(ASCII_ESCAPE_RE, (_match: string, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }
  });
}

/**
 * Decodes percent escapes until the value stops changing (`%40`, `%2540`, `%252540`, ...). Returns null
 * when it still changes after `MAX_DECODE_PASSES`: nothing legitimate is encoded that deep.
 */
function decodeEscapes(value: string): string | null {
  let out = value;
  for (let pass = 0; pass <= MAX_DECODE_PASSES; pass++) {
    const next = decodeOnce(out);
    if (next === out) return out;
    out = next;
  }
  return null;
}

/**
 * Re-encodes a decoded segment after redaction. Delimiters, `%` and controls are escaped so the URL keeps its
 * shape; `:` and `@` stay literal (`mailto:`). Non-ASCII text is escaped as UTF-8, matching how it arrived,
 * unless the original segment already carried it raw (free text), in which case it stays raw.
 */
function encodeSegment(value: string, keepRawUnicode: boolean): string {
  return value
    .split(REDACTED)
    .map(part => part.replace(SEGMENT_UNSAFE_RE, (char: string) => {
      if (keepRawUnicode && NON_ASCII_RE.test(char)) return char;
      try {
        return encodeURIComponent(char);
      } catch {
        return '';
      }
    }))
    .join(REDACTED);
}

/**
 * Redacts emails that only appear once percent-decoded (`john%40x.com`, `john%2540x.com`, `zuey%20john%40x.com`).
 * A segment carrying one is decoded, its emails replaced, and re-encoded so the rest of the URL keeps its shape.
 * A segment still encoded after the decoding limit is redacted whole.
 */
function redactEncodedEmails(value: string): string {
  if (!value.includes('%')) return value;
  return value.replace(SEGMENT_RE, (segment: string) => {
    if (!segment.includes('%')) return segment;
    const decoded = decodeEscapes(segment);
    if (decoded === null) return REDACTED;
    if (!hasEmail(decoded)) return segment;
    return encodeSegment(redactEmails(decoded),NON_ASCII_RE.test(segment));
  });
}

/** True when a string carries an email address, literally or percent-encoded, or is encoded too deep to inspect. */
export function looksLikeEmail(value: string): boolean {
  if (hasEmail(value)) return true;
  if (!value.includes('%')) return false;
  const decoded = decodeEscapes(value);
  return decoded === null || hasEmail(decoded);
}

export function looksLikeJwt(value: string): boolean {
  return redactJwts(value) !== value;
}

/** True when a string carries an email address, a JWT or a recognisable secret token, or is too long to inspect. */
export function containsPii(value: string): boolean {
  if (value.length > MAX_SCRUB_LENGTH) return true;
  return looksLikeEmail(value) || looksLikeJwt(value) || test(SECRET_RE, value);
}

function scrubParams(params: URLSearchParams, ownSite: boolean): boolean {
  let changed = false;
  for (const name of [...new Set(params.keys())]) {
    if (isSensitiveParam(name) || (ownSite && isSearchParam(name))) {
      params.delete(name);
      changed = true;
    }
  }
  return changed;
}

/**
 * Removes sensitive query parameters (and fragment parameters such as `#access_token=`) from an
 * absolute or root-relative URL, plus the search words on zuey.me's own addresses. Values that do not
 * parse as a URL go through `redactString` instead.
 */
export function scrubUrl(raw: string): string {
  const input = capLength(raw);
  const relative = input.startsWith('/') && !input.startsWith('//');
  const absolute = /^https?:\/\//i.test(input);
  if (!relative && !absolute) return redactString(input);
  let parsed: URL;
  try {
    parsed = new URL(input, 'https://relative.invalid');
  } catch {
    return redactString(input);
  }
  const ownSite = relative || PRODUCTION_HOSTNAMES.includes(parsed.hostname);
  if (isSensitivePath(parsed.pathname)) {
    parsed.search = '';
    parsed.hash = '';
  }
  scrubParams(parsed.searchParams, ownSite);
  if (parsed.hash.includes('=')) {
    const hashParams = new URLSearchParams(parsed.hash.slice(1));
    if (scrubParams(hashParams, ownSite)) {
      const rest = hashParams.toString();
      parsed.hash = rest ? `#${rest}` : '';
    }
  }
  if (parsed.username || parsed.password) {
    parsed.username = '';
    parsed.password = '';
  }
  const out = relative ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString();
  return redactText(out, false);
}

function redactText(value: string, redactSearch: boolean): string {
  const params = templatePaths(capLength(value))
    .replace(INLINE_PARAM_RE, (match: string, lead: string, name: string) => (
      isSensitiveParam(name) || (redactSearch && isSearchParam(name)) ? `${lead}${name}=${REDACTED}` : match
    ));
  return redactEncodedEmails(redactEmails(redactJwts(params).replace(SECRET_RE, REDACTED)));
}

/**
 * Replaces emails (literal or percent-encoded), JWTs, secret tokens, sensitive `name=value` pairs (search
 * words included), order codes and booking ids in paths inside arbitrary text.
 */
export function redactString(value: string): string {
  return redactText(value, true);
}

function scrubString(value: string): string {
  return /^(?:https?:\/\/|\/(?!\/))/i.test(value) ? scrubUrl(value) : redactString(value);
}

const MAX_DEPTH = 6;

/**
 * Deep-scrubs an arbitrary property bag (PostHog's automatic properties, `$set`, `$elements`):
 * URLs lose sensitive parameters and every string is redacted. Objects nested deeper than `MAX_DEPTH` are
 * replaced by `[redacted]` rather than passed through. Returns a new value; input untouched.
 */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map(item => scrubValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = scrubValue(item, depth + 1);
  return out;
}
