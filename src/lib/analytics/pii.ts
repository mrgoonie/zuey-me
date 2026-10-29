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
/**
 * A retina asset suffix (`image@2x.png`, `logo@3x.webp`) matched as a whole domain: a 1- or 2-digit scale and an image
 * extension with no further labels. It is a file name, not an email; `a@2x.example.com` still is one.
 */
const RETINA_ASSET_RE = /^@\d{1,2}x\.(?:png|jpe?g|gif|webp|avif|svg)$/i;
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
 * Paths whose pages show account, billing, booking or AI data, or hand a member off to Dewee Connect (`/dewee/connect`). Their
 * URLs lose the whole query string and fragment (booking manage tokens, PayPal return parameters, Dewee Connect references)
 * and autocapture is off there.
 */
const SENSITIVE_PATH_RE = /^\/(?:account|login|billing|booking|chat|dewee\/connect|oauth|studio|courses\/orders)(?:\/|$)/;

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
    if (start === at || RETINA_ASSET_RE.test(match[0])) {
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
  return replaceRanges(value, emailRanges(value));
}

/**
 * A run of digit groups joined by one separator each (a space, `.` or `-` with optional spaces around it, or a
 * parenthesised area code), with an optional leading `+`. A space may also be a no-break space (U+00A0, U+202F).
 * Every group needs a digit and a separator, so the regex never backtracks over a run and the scan is linear; which
 * part of a run is a phone number is decided by `phoneRanges`.
 */
const PHONE_RUN_RE = /\+?\(?\d+(?:(?:[ \u00a0\u202f]?[.-][ \u00a0\u202f]?|[ \u00a0\u202f]|\)[ \u00a0\u202f]?)\(?\d+)*\)?/g;
const SPACE_RE = /[ \u00a0\u202f]/;
const PLAIN_SPACE_RE = /^[ \u00a0\u202f]$/;
const WORD_CHAR_RE = /^[\p{L}\p{N}_]$/u;
const JOINER_RE = /^[-._]$/;
/** Most digits in a phone number (E.164). A window of groups never grows past this, which bounds the scan. */
const MAX_PHONE_DIGITS = 15;
/** Fewest digits any accepted shape has (`+` and 9 digits), checked first to skip short windows cheaply. */
const MIN_PHONE_DIGITS = 9;
/** Vietnamese mobile (`03`, `05`, `07`, `08`, `09` + 8 digits) and landline (`02` + 9 digits) numbers. */
const VN_PHONE_RE = /^(?:0[35789]\d{8}|02\d{9})$/;
/** The same numbers with the `84` country code and no `+`, as `wa.me/84901234567` links write them (one group only). */
const VN_INTL_PHONE_RE = /^84(?:[35789]\d{8}|2\d{9})$/;
/** North American `NXX NXX XXXX`, accepted only when written in three groups. */
const NANP_PHONE_RE = /^[2-9]\d{2}[2-9]\d{6}$/;

/** `sep` is the text between the previous group and this one (`''` for the first group of a run). */
interface DigitGroup { start: number; end: number; digits: string; sep: string; spaceBefore: boolean }

/**
 * True when a digit run touches an identifier: a letter, digit or `_` right next to it, or a joiner (`-`, `.`,
 * `_`) followed by one. Order codes (`ZMC-0901234567`), hashes, UUIDs, file names (`0901234567.png`) and
 * versions (`v1.0901234567`) are therefore never read as phone numbers.
 */
function touchesWord(value: string, index: number, step: 1 | -1): boolean {
  const near = value.charAt(index);
  if (WORD_CHAR_RE.test(near)) return true;
  return JOINER_RE.test(near) && WORD_CHAR_RE.test(value.charAt(index + step));
}

interface PhoneWindow { plus: boolean; count: number; firstLength: number; secondLength: number; spacedOnly: boolean }

/**
 * Whether the digits of `count` consecutive groups form a phone number. Groups after the first always have at
 * least two digits (the caller stops there); the first may have one only after a `+` (`+1 415 555 2671`). A North
 * American number written with plain spaces only (`256 384 1024`) is too often a list of sizes or SVG coordinates,
 * so it needs a `(`, `)`, `.` or `-` somewhere.
 */
function isPhoneNumber(digits: string, w: PhoneWindow): boolean {
  if (w.plus && digits.length >= 9 && digits.charAt(0) !== '0') return true;
  if (w.firstLength < 2) return false;
  if (VN_PHONE_RE.test(digits)) return true;
  if (w.count === 1 && VN_INTL_PHONE_RE.test(digits)) return true;
  return w.count === 3 && w.firstLength === 3 && w.secondLength === 3 && !w.spacedOnly && NANP_PHONE_RE.test(digits);
}

/** The digit groups of one run, with the separator before each. */
function digitGroups(run: string, runStart: number): DigitGroup[] {
  const groups: DigitGroup[] = [];
  const groupRe = /\d+/g;
  let digitMatch = groupRe.exec(run);
  let previousEnd = 0;
  while (digitMatch !== null) {
    const start = runStart + digitMatch.index;
    const sep = groups.length === 0 ? '' : run.slice(previousEnd, digitMatch.index);
    groups.push({ start, end: start + digitMatch[0].length, digits: digitMatch[0], sep, spaceBefore: SPACE_RE.test(sep) });
    previousEnd = digitMatch.index + digitMatch[0].length;
    digitMatch = groupRe.exec(run);
  }
  return groups;
}

/**
 * `[start, end)` of every phone number: Vietnamese `0xxxxxxxxx` and `02xxxxxxxxx` (also `84xxxxxxxxx` written as one
 * group), `+` followed by 9 to 15 digits (E.164, `+84 90 123 4567`, `+84 (0) 90 123 4567`), and North American
 * `(415) 555-2671`, with spaces, dots, dashes or a parenthesised area code between groups. From `queryStart` on (the
 * raw query and fragment of a URL) a `+` glued to a word is an encoded space (`q=zuey+0901234567`), not a country-code
 * prefix; anywhere else (paths, free text, decoded `%2B`) it is a real plus. A run of numbers is split only at spaces,
 * so two numbers in a row are both found, while ISO dates, times, timestamps, prices, versions, IP addresses and order
 * ids never form one of these shapes. Each window of groups is capped at `MAX_PHONE_DIGITS` digits, so the scan stays
 * linear.
 */
function phoneRanges(value: string, queryStart = Infinity): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  if (!/\d/.test(value)) return ranges;
  PHONE_RUN_RE.lastIndex = 0;
  let match = PHONE_RUN_RE.exec(value);
  while (match !== null) {
    const run = match[0];
    const runStart = match.index;
    const runEnd = runStart + run.length;
    const groups = digitGroups(run, runStart);
    const plusSpace = run.startsWith('+') && runStart >= queryStart && WORD_CHAR_RE.test(charBefore(value, runStart));
    const plus = run.startsWith('+') && !plusSpace;
    const gluedBefore = !run.startsWith('+') && !run.startsWith('(') && touchesWord(value, runStart - 1, -1);
    const gluedAfter = touchesWord(value, runEnd, 1);
    let i = 0;
    while (i < groups.length) {
      const first = groups[i];
      const plusHere = plus && i === 0;
      const opensRun = i === 0 ? !gluedBefore : first?.spaceBefore === true;
      const firstLength = first?.digits.length ?? 0;
      let best = -1;
      if (first && opensRun && (firstLength >= 2 || plusHere)) {
        const parenthesised = i === 0 ? run.startsWith('(') : first.sep.endsWith('(');
        let digits = '';
        let count = 0;
        let secondLength = 0;
        let spacedOnly = !parenthesised;
        for (let j = i; j < groups.length; j++) {
          const group = groups[j];
          if (!group) break;
          // `+84 (0) 90 …`: the national trunk prefix written after a country code is not part of the number.
          const trunk = plusHere && j === i + 1 && group.digits === '0' && group.sep.endsWith('(') && value.charAt(group.end) === ')';
          if (!trunk) {
            if (j > i && group.digits.length < 2) break;
            digits += group.digits;
            count++;
            if (digits.length > MAX_PHONE_DIGITS) break;
            if (count === 2) secondLength = group.digits.length;
            if (j > i && !PLAIN_SPACE_RE.test(group.sep)) spacedOnly = false;
          }
          const closesRun = j === groups.length - 1 ? !gluedAfter : groups[j + 1]?.spaceBefore === true;
          if (!trunk && closesRun && digits.length >= MIN_PHONE_DIGITS && isPhoneNumber(digits, { plus: plusHere, count, firstLength, secondLength, spacedOnly })) best = j;
        }
      }
      if (best < 0) {
        i++;
        continue;
      }
      const last = groups[best];
      if (first && last) {
        const start = i === 0 ? runStart + (plusSpace ? 1 : 0) : first.start - (value.charAt(first.start - 1) === '(' ? 1 : 0);
        const end = best === groups.length - 1 ? runEnd : last.end + (value.charAt(last.end) === ')' ? 1 : 0);
        ranges.push([start, end]);
      }
      i = best + 1;
    }
    match = PHONE_RUN_RE.exec(value);
  }
  PHONE_RUN_RE.lastIndex = 0;
  return ranges;
}
function hasPhone(value: string): boolean {
  return phoneRanges(value).length > 0;
}

/** Replaces each `[start, end)` range (sorted, non-overlapping) with `[redacted]`. */
function replaceRanges(value: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return value;
  let out = '';
  let last = 0;
  for (const [start, end] of ranges) {
    out += `${value.slice(last, start)}${REDACTED}`;
    last = end;
  }
  return out + value.slice(last);
}

function redactPhones(value: string, queryStart = Infinity): string {
  return replaceRanges(value, phoneRanges(value, queryStart));
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
/** In a URL query a literal `+` means a space, so a decoded plus (`%2B`) is escaped again there. */
const QUERY_UNSAFE_RE = /[^A-Za-z0-9._~\-:@!$*,()]/gu;
const NON_ASCII_RE = /[^\x00-\x7F]/;
/**
 * Stands in for a raw `+` of a URL query while its segment is decoded: it is an encoded space there, so it must
 * neither join an email nor prefix a phone number, unlike a decoded `%2B`. A private-use character never in a URL.
 */
const QUERY_SPACE = '\uE000';

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
 * unless the original segment already carried it raw (free text), in which case it stays raw. In a URL query a
 * decoded plus becomes `%2B` again and each `QUERY_SPACE` its original raw `+`.
 */
function encodeSegment(value: string, keepRawUnicode: boolean, inQuery: boolean): string {
  return value
    .split(REDACTED)
    .map(part => part.replace(inQuery ? QUERY_UNSAFE_RE : SEGMENT_UNSAFE_RE, (char: string) => {
      if (char === QUERY_SPACE) return '+';
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
 * Redacts emails and phone numbers that only appear once percent-decoded (`john%40x.com`, `john%2540x.com`,
 * `zuey%20john%40x.com`, `%2B84%20901%20234%20567`). A segment carrying one is decoded, its emails and phone numbers
 * replaced, and re-encoded so the rest of the URL keeps its shape.
 * A segment still encoded after the decoding limit is redacted whole. From `queryStart` on, a raw `+` is a space
 * while the segment is inspected, and any plus left after decoding is a real one (`%2B44…`).
 */
function redactEncodedEmails(value: string, queryStart = Infinity): string {
  if (!value.includes('%')) return value;
  return value.replace(SEGMENT_RE, (segment: string, offset: number) => {
    if (!segment.includes('%')) return segment;
    const inQuery = offset >= queryStart;
    const decoded = decodeEscapes(inQuery ? segment.replaceAll('+', QUERY_SPACE) : segment);
    if (decoded === null) return REDACTED;
    if (!hasEmail(decoded) && !hasPhone(decoded)) return segment;
    return encodeSegment(redactPhones(redactEmails(decoded)), NON_ASCII_RE.test(segment), inQuery);
  });
}

/** Where the query or fragment of a URL starts, or `Infinity` for free text. */
function queryStartOf(value: string, isUrl: boolean): number {
  const index = isUrl ? value.search(/[?#]/) : -1;
  return index < 0 ? Infinity : index;
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

/** True when a string carries a phone number, literally or percent-encoded (`%2B84%20901…`). */
export function looksLikePhone(value: string): boolean {
  if (hasPhone(value)) return true;
  if (!value.includes('%')) return false;
  const decoded = decodeEscapes(value);
  return decoded !== null && hasPhone(decoded);
}

/** True when a string carries an email address, a phone number, a JWT or a recognisable secret token, or is too long to inspect. */
export function containsPii(value: string): boolean {
  if (value.length > MAX_SCRUB_LENGTH) return true;
  return looksLikeEmail(value) || looksLikePhone(value) || looksLikeJwt(value) || test(SECRET_RE, value);
}

/**
 * The parameters left once sensitive ones (and, on zuey.me, search words) are removed, or null when none is.
 * One pass over the entries builds the result: deleting names one at a time re-serialises the whole query on
 * every call, which is quadratic and took ~80 ms in V8 on a 16 KB URL with thousands of sensitive names.
 */
function keptParams(params: URLSearchParams, ownSite: boolean): URLSearchParams | null {
  const kept: Array<[string, string]> = [];
  let removed = false;
  for (const [name, value] of params) {
    if (isSensitiveParam(name) || (ownSite && isSearchParam(name))) removed = true;
    else kept.push([name, value]);
  }
  return removed ? new URLSearchParams(kept) : null;
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
  const ownSite = relative || PRODUCTION_HOSTNAMES.includes(parsed.hostname.replace(/\.$/, ''));
  if (isSensitivePath(parsed.pathname)) {
    parsed.search = '';
    parsed.hash = '';
  }
  const query = keptParams(parsed.searchParams, ownSite);
  if (query) parsed.search = query.toString();
  if (parsed.hash.includes('=')) {
    const hashParams = keptParams(new URLSearchParams(parsed.hash.slice(1)), ownSite);
    if (hashParams) {
      const rest = hashParams.toString();
      parsed.hash = rest ? `#${rest}` : '';
    }
  }
  if (parsed.username || parsed.password) {
    parsed.username = '';
    parsed.password = '';
  }
  const out = relative ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString();
  return redactText(out, false, true);
}

/** `isUrl`: the value is a parsed URL, so a `+` in its query or fragment is an encoded space. */
function redactText(value: string, redactSearch: boolean, isUrl = false): string {
  const params = templatePaths(capLength(value))
    .replace(INLINE_PARAM_RE, (match: string, lead: string, name: string) => (
      isSensitiveParam(name) || (redactSearch && isSearchParam(name)) ? `${lead}${name}=${REDACTED}` : match
    ));
  const literal = redactEmails(redactJwts(params).replace(SECRET_RE, REDACTED));
  const phonesOut = redactPhones(literal, queryStartOf(literal, isUrl));
  return redactEncodedEmails(phonesOut, queryStartOf(phonesOut, isUrl));
}

/**
 * Replaces emails and phone numbers (literal or percent-encoded), JWTs, secret tokens, sensitive `name=value` pairs (search
 * words included), order codes and booking ids in paths inside arbitrary text.
 */
export function redactString(value: string): string {
  return redactText(value, true);
}

/**
 * Scrubbed form of each distinct string already seen while scrubbing one event. PostHog copies the same URL into
 * many properties (`$current_url`, `$session_entry_url`, `$initial_current_url`, `$set`, ...), so a crafted link
 * is scrubbed once per event rather than once per copy.
 */
export type ScrubCache = Map<string, string>;

function scrubString(value: string, cache: ScrubCache): string {
  const known = cache.get(value);
  if (known !== undefined) return known;
  const out = /^(?:https?:\/\/|\/(?!\/))/i.test(value) ? scrubUrl(value) : redactString(value);
  cache.set(value, out);
  return out;
}

const MAX_DEPTH = 6;

/**
 * Deep-scrubs an arbitrary property bag (PostHog's automatic properties, `$set`, `$elements`):
 * URLs lose sensitive parameters and every string is redacted. Objects nested deeper than `MAX_DEPTH` are
 * replaced by `[redacted]` rather than passed through. Returns a new value; input untouched. Pass the same `cache`
 * for every part of one event so each distinct string is scrubbed once.
 */
export function scrubValue(value: unknown, cache: ScrubCache = new Map(), depth = 0): unknown {
  if (typeof value === 'string') return scrubString(value, cache);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map(item => scrubValue(item, cache, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = scrubValue(item, cache, depth + 1);
  return out;
}
