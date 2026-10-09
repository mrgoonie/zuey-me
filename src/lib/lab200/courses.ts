/**
 * 200lab courses: parsing https://200lab.io/courses.md and building referral links.
 * Every link to a 200lab course on zuey.me must come from `courseLink`, so the referral code
 * (20% off for the buyer) is never missing.
 */

export const LAB200_ORIGIN = 'https://200lab.io';
export const LAB200_COURSES_MD = `${LAB200_ORIGIN}/courses.md`;
export const LAB200_REF = 'T2CWW3D7';

/** Courses Duy recommends, shown first. Slugs missing from the live list are skipped. */
export const LAB200_FEATURED_SLUGS = [
  'agent-harness-foundations',
  'lam-chu-tu-duy-trong-thoi-dai-ai-tu-duy-he-thong-cach-giao-viec-va-quan-ly-agent',
  'thiet-ke-he-thong-uoc-luong-tai-load-balancer-cache-queue-replication-va-partitioning',
];

export interface Lab200Course {
  slug: string;
  title: string;
  summary: string;
  lessons: number | null;
  /** Sale status as published by 200lab, e.g. "Đang mở bán, giá từ 199.000 ₫" or "Miễn phí". */
  status: string;
  free: boolean;
  /** Thumbnail (the course page's og:image on assets.200lab.io); null or missing when unknown. */
  image?: string | null;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// "- [Title](https://200lab.io/courses/<slug>.md): summary · N bài học · status"
const LINE_RE = /^- \[(.+)\]\((\S+)\):\s*(.*)$/;
const LESSONS_RE = /^(\d+)\s+bài học$/i;

/** Course page (never the `.md` variant) with the referral code. */
export function courseLink(slug: string): string {
  return `${LAB200_ORIGIN}/courses/${encodeURIComponent(slug)}?ref=${LAB200_REF}`;
}

/** Plain course page, used only to read its thumbnail (no referral code: it is not a visitor click). */
export function coursePageUrl(slug: string): string {
  return `${LAB200_ORIGIN}/courses/${encodeURIComponent(slug)}`;
}

const META_TAG_RE = /<meta\b[^>]*>/gi;

/** The og:image URL in a course page's HTML, accepted only when it is served by https://assets.200lab.io. */
export function courseImageFromHtml(html: string): string | null {
  for (const tag of html.match(META_TAG_RE) ?? []) {
    if (!/\bproperty\s*=\s*["']og:image["']/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!content) continue;
    try {
      const url = new URL(content.replace(/&amp;/g, '&'));
      if (url.protocol === 'https:' && url.hostname === 'assets.200lab.io') return url.toString();
    } catch {
      // Not a URL; keep looking.
    }
  }
  return null;
}

/** Course slug from a 200lab course URL, with or without `.md`; null for anything else. */
export function slugFromCourseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hostname !== '200lab.io') return null;
  const m = /^\/courses\/([^/]+?)(?:\.md)?\/?$/.exec(url.pathname);
  return m && SLUG_RE.test(m[1]) ? m[1] : null;
}

/**
 * Courses listed in 200lab's courses.md, in source order. Lines that do not match the expected
 * shape are skipped; callers treat an empty result as a failed fetch.
 */
export function parseCoursesMarkdown(md: string): Lab200Course[] {
  const courses: Lab200Course[] = [];
  const seen = new Set<string>();
  for (const line of md.split(/\r?\n/)) {
    const m = LINE_RE.exec(line.trim());
    if (!m) continue;
    const slug = slugFromCourseUrl(m[2]);
    if (!slug || seen.has(slug)) continue;
    const parts = m[3].split(' · ').map(p => p.trim()).filter(Boolean);
    const lessonsIdx = parts.findIndex(p => LESSONS_RE.test(p));
    const lessons = lessonsIdx >= 0 ? Number(LESSONS_RE.exec(parts[lessonsIdx])![1]) : null;
    // Summary is everything before the lesson count; status everything after it.
    const summary = (lessonsIdx >= 0 ? parts.slice(0, lessonsIdx) : parts.slice(0, -1)).join(' · ');
    const status = (lessonsIdx >= 0 ? parts.slice(lessonsIdx + 1) : parts.slice(-1)).join(' · ');
    seen.add(slug);
    courses.push({
      slug,
      title: m[1].trim(),
      summary,
      lessons,
      status,
      free: /miễn phí/i.test(status),
    });
  }
  return courses;
}

/** Featured courses (in featured order) and the rest (in 200lab's order). */
export function splitFeatured(courses: Lab200Course[]): { featured: Lab200Course[]; others: Lab200Course[] } {
  const bySlug = new Map(courses.map(c => [c.slug, c]));
  const featured = LAB200_FEATURED_SLUGS.map(s => bySlug.get(s)).filter((c): c is Lab200Course => Boolean(c));
  const picked = new Set(featured.map(c => c.slug));
  return { featured, others: courses.filter(c => !picked.has(c.slug)) };
}
