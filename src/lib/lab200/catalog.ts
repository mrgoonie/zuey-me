/**
 * 200lab catalog contract: the versioned JSON feeds https://200lab.io/courses.json and
 * https://200lab.io/learning-paths.json, validated into typed items, plus the one referral link builder.
 *
 * The same validators run on the upstream payload, on rows read back from D1 and on the
 * /api/v1/lab200 response in the browser, so every surface sees the same sanitized shape. Validation
 * fails closed: an item with a non-canonical URL, a foreign image host or a malformed price is
 * dropped, and a feed with an unsupported version, no list or no valid item is rejected whole.
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const LAB200_ORIGIN = 'https://200lab.io';
const LAB200_HOST = '200lab.io';
const LAB200_ASSET_HOST = 'assets.200lab.io';
/** Catalog feed version this parser understands; anything else is rejected. */
export const LAB200_CATALOG_VERSION = 1;
/** Duy's referral code, added once to every 200lab link by `lab200Link`. */
export const LAB200_REF = 'T2CWW3D7';

export type Lab200Kind = 'courses' | 'learningPaths';

export const LAB200_FEEDS: Record<Lab200Kind, { url: string; listKey: string; pathPrefix: string }> = {
  courses: { url: `${LAB200_ORIGIN}/courses.json`, listKey: 'courses', pathPrefix: '/courses/' },
  learningPaths: { url: `${LAB200_ORIGIN}/learning-paths.json`, listKey: 'learningPaths', pathPrefix: '/learning-paths/' },
};

/** Courses Duy recommends, shown first. Slugs missing from the live list are skipped. */
export const LAB200_FEATURED_SLUGS = [
  'agent-harness-foundations',
  'lam-chu-tu-duy-trong-thoi-dai-ai-tu-duy-he-thong-cach-giao-viec-va-quan-ly-agent',
  'thiet-ke-he-thong-uoc-luong-tai-load-balancer-cache-queue-replication-va-partitioning',
  'xay-copilot-ho-tro-nguoi-truc-chat-tu-cau-chuyen-that-den-san-pham-chay-duoc',
];

/** Currencies the app can format; prices in any other currency are dropped. */
export type Lab200Currency = 'VND';

export interface Lab200Price {
  /** Selling price in the currency's minor units (VND has none, so this is whole dong). */
  minorUnits: number;
  currency: Lab200Currency;
  /** 200lab's own comparison (strikethrough) price; not a referral price. */
  compareAtMinorUnits: number | null;
}

export interface Lab200Pricing {
  /** Any state other than `available` (or an unknown one) is shown as not purchasable. */
  state: 'available' | 'unavailable';
  prices: Lab200Price[];
}

export interface Lab200Cover {
  url: string;
  /** Resized copies on assets.200lab.io, narrowest first. */
  variants: Array<{ width: number; url: string }>;
}

interface Lab200ItemBase {
  slug: string;
  /** Canonical page on https://200lab.io (validated); link to it through `lab200Link`. */
  url: string;
  /** Canonical detail JSON for this item (validated, not fetched by the list view). */
  jsonUrl: string;
  title: string;
  subtitle: string;
  summary: string;
  cover: Lab200Cover | null;
  publishedAt: string | null;
  pricing: Lab200Pricing;
}

export interface Lab200Course extends Lab200ItemBase {
  category: { slug: string; name: string } | null;
  lessonCount: number | null;
  readingMinutes: number | null;
}

export interface Lab200LearningPath extends Lab200ItemBase {
  courseCount: number | null;
}

export type Lab200FeedResult<T> =
  | { ok: true; locale: string; items: T[] }
  | { ok: false; reason: string };

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;
const MAX_ITEMS = 500;
const MAX_PRICES = 10;
const MAX_VARIANTS = 8;
const MAX_URL_LENGTH = 2048;
const MAX_COUNT = 1_000_000;

/** One line of plain text: tags, control characters and runs of whitespace removed, length capped. */
export function sanitizeText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const clean = v
    .replace(/<\/?[a-z!][^>]*>/gi, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_COUNT ? v : null;
}

function parseHttpsUrl(raw: unknown, host: string): URL | null {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password) return null;
  return url;
}

/** `raw` when it is exactly `https://200lab.io<prefix><slug><suffix>` (query kept, fragment dropped); otherwise null. */
function canonicalUrl(raw: unknown, path: string, allowQuery: boolean): string | null {
  const url = parseHttpsUrl(raw, LAB200_HOST);
  if (!url || url.pathname !== path || (!allowQuery && url.search)) return null;
  return `${LAB200_ORIGIN}${url.pathname}${url.search}`;
}

/** An image URL served over https by assets.200lab.io; null for anything else. */
export function lab200AssetUrl(raw: unknown): string | null {
  return parseHttpsUrl(raw, LAB200_ASSET_HOST)?.toString() ?? null;
}

function parseCover(v: unknown): Lab200Cover | null {
  if (!isRecord(v)) return null;
  const variants = (Array.isArray(v.variants) ? v.variants : [])
    .flatMap(x => {
      if (!isRecord(x)) return [];
      const width = count(x.width);
      const url = lab200AssetUrl(x.url);
      return width && width <= 8192 && url ? [{ width, url }] : [];
    })
    .sort((a, b) => a.width - b.width)
    .slice(0, MAX_VARIANTS);
  const url = lab200AssetUrl(v.url) ?? variants.at(-1)?.url ?? null;
  return url ? { url, variants } : null;
}

/**
 * Pricing, or null when it is malformed (the item is then dropped). A price in an unsupported
 * currency is skipped; a comparison price that is not above the selling price is ignored.
 */
export function parseLab200Pricing(v: unknown): Lab200Pricing | null {
  if (!isRecord(v) || typeof v.state !== 'string') return null;
  if (v.prices !== undefined && v.prices !== null && !Array.isArray(v.prices)) return null;
  const raw: unknown[] = Array.isArray(v.prices) ? v.prices : [];
  if (raw.length > MAX_PRICES) return null;
  const prices: Lab200Price[] = [];
  for (const p of raw) {
    if (!isRecord(p) || typeof p.currency !== 'string' || !/^[A-Z]{3}$/.test(p.currency)) return null;
    const minorUnits = p.minorUnits;
    if (typeof minorUnits !== 'number' || !Number.isSafeInteger(minorUnits) || minorUnits < 0) return null;
    const cmp = p.compareAtMinorUnits;
    if (cmp !== undefined && cmp !== null && (typeof cmp !== 'number' || !Number.isSafeInteger(cmp) || cmp < 0)) return null;
    if (p.currency !== 'VND') continue;
    prices.push({ minorUnits, currency: 'VND', compareAtMinorUnits: typeof cmp === 'number' && cmp > minorUnits ? cmp : null });
  }
  return { state: v.state === 'available' ? 'available' : 'unavailable', prices };
}

function parseBase(v: unknown, kind: Lab200Kind): Lab200ItemBase | null {
  if (!isRecord(v) || typeof v.slug !== 'string' || v.slug.length > 200 || !SLUG_RE.test(v.slug)) return null;
  const path = `${LAB200_FEEDS[kind].pathPrefix}${v.slug}`;
  const url = canonicalUrl(v.url, path, true);
  const jsonUrl = canonicalUrl(v.jsonUrl, `${path}.json`, false);
  const title = sanitizeText(v.title, 300);
  const pricing = parseLab200Pricing(v.pricing);
  if (!url || !jsonUrl || !title || !pricing) return null;
  const published = typeof v.publishedAt === 'string' ? Date.parse(v.publishedAt) : NaN;
  return {
    slug: v.slug,
    url,
    jsonUrl,
    title,
    subtitle: sanitizeText(v.subtitle, 500),
    summary: sanitizeText(v.summary, 1200),
    cover: parseCover(v.cover),
    publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : null,
    pricing,
  };
}

export function parseLab200Course(v: unknown): Lab200Course | null {
  const base = parseBase(v, 'courses');
  if (!base || !isRecord(v)) return null;
  const cat = isRecord(v.category) ? v.category : null;
  const catSlug = cat && typeof cat.slug === 'string' && SLUG_RE.test(cat.slug) ? cat.slug : '';
  const catName = cat ? sanitizeText(cat.name, 80) : '';
  return {
    ...base,
    category: catSlug && catName ? { slug: catSlug, name: catName } : null,
    lessonCount: count(v.lessonCount),
    readingMinutes: count(v.readingMinutes),
  };
}

export function parseLab200LearningPath(v: unknown): Lab200LearningPath | null {
  const base = parseBase(v, 'learningPaths');
  if (!base || !isRecord(v)) return null;
  return { ...base, courseCount: count(v.courseCount) };
}

/** Valid items of a list (stored rows or an API response), deduplicated by slug, in source order. */
export function parseLab200Items(kind: 'courses', list: unknown): Lab200Course[];
export function parseLab200Items(kind: 'learningPaths', list: unknown): Lab200LearningPath[];
export function parseLab200Items(kind: Lab200Kind, list: unknown): Array<Lab200Course | Lab200LearningPath>;
export function parseLab200Items(kind: Lab200Kind, list: unknown): Array<Lab200Course | Lab200LearningPath> {
  if (!Array.isArray(list)) return [];
  const parse = kind === 'courses' ? parseLab200Course : parseLab200LearningPath;
  const seen = new Set<string>();
  const items: Array<Lab200Course | Lab200LearningPath> = [];
  for (const raw of list.slice(0, MAX_ITEMS)) {
    const item = parse(raw);
    if (!item || seen.has(item.slug)) continue;
    seen.add(item.slug);
    items.push(item);
  }
  return items;
}

/** Validate a whole upstream feed (`{version, locale, courses|learningPaths}`). */
export function parseLab200Feed(kind: 'courses', payload: unknown): Lab200FeedResult<Lab200Course>;
export function parseLab200Feed(kind: 'learningPaths', payload: unknown): Lab200FeedResult<Lab200LearningPath>;
export function parseLab200Feed(kind: Lab200Kind, payload: unknown): Lab200FeedResult<Lab200Course | Lab200LearningPath>;
export function parseLab200Feed(kind: Lab200Kind, payload: unknown): Lab200FeedResult<Lab200Course | Lab200LearningPath> {
  if (!isRecord(payload)) return { ok: false, reason: 'payload is not an object' };
  if (payload.version !== LAB200_CATALOG_VERSION) return { ok: false, reason: `unsupported version ${String(payload.version)}` };
  if (typeof payload.locale !== 'string' || !LOCALE_RE.test(payload.locale)) return { ok: false, reason: 'missing or invalid locale' };
  const list = payload[LAB200_FEEDS[kind].listKey];
  if (!Array.isArray(list) || list.length === 0) return { ok: false, reason: `${LAB200_FEEDS[kind].listKey} is missing or empty` };
  if (list.length > MAX_ITEMS) return { ok: false, reason: `${LAB200_FEEDS[kind].listKey} has more than ${MAX_ITEMS} items` };
  const items = parseLab200Items(kind, list);
  if (items.length === 0) return { ok: false, reason: `no valid ${LAB200_FEEDS[kind].listKey}` };
  return { ok: true, locale: payload.locale, items };
}

/**
 * The only way to link to 200lab: the validated canonical page with `ref=T2CWW3D7` set exactly once
 * (an existing `ref` is replaced, other query parameters are kept). Anything that is not an
 * https://200lab.io URL falls back to the 200lab home page.
 */
export function lab200Link(canonical: string): string {
  const url = parseHttpsUrl(canonical, LAB200_HOST) ?? new URL(`${LAB200_ORIGIN}/`);
  url.searchParams.delete('ref');
  url.searchParams.set('ref', LAB200_REF);
  url.hash = '';
  return url.toString();
}

export type Lab200PriceView =
  | { kind: 'free' }
  | { kind: 'paid'; amount: number; from: boolean; compareAt: number | null }
  | { kind: 'unavailable' }
  /** Available, but 200lab published no price the app can show. */
  | { kind: 'unknown' };

/** What to show for an item's price, straight from 200lab's pricing (no referral arithmetic). */
export function lab200PriceView(pricing: Lab200Pricing): Lab200PriceView {
  if (pricing.state !== 'available') return { kind: 'unavailable' };
  if (pricing.prices.length === 0) return { kind: 'unknown' };
  const lowest = pricing.prices.reduce((a, b) => (b.minorUnits < a.minorUnits ? b : a));
  if (lowest.minorUnits === 0) return { kind: 'free' };
  return {
    kind: 'paid',
    amount: lowest.minorUnits,
    from: pricing.prices.some(p => p.minorUnits !== lowest.minorUnits),
    compareAt: lowest.compareAtMinorUnits,
  };
}

/** "199.000 ₫" — grouped by hand so server and browser render the same text whatever their ICU data. */
export function formatVnd(amount: number): string {
  return `${String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} ₫`;
}

/** Featured courses (in featured order) and the rest (in 200lab's order). */
export function splitFeatured(courses: Lab200Course[]): { featured: Lab200Course[]; others: Lab200Course[] } {
  const bySlug = new Map(courses.map(c => [c.slug, c]));
  const featured = LAB200_FEATURED_SLUGS.map(s => bySlug.get(s)).filter((c): c is Lab200Course => Boolean(c));
  const picked = new Set(featured.map(c => c.slug));
  return { featured, others: courses.filter(c => !picked.has(c.slug)) };
}
