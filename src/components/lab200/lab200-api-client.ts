/** Client-side validation of GET /api/v1/lab200 (untrusted JSON → typed values). */
import { isRecord } from '../home/storage';
import type { Lab200Course } from '../../lib/lab200/courses';
import type { Lab200Snapshot } from '../../lib/lab200/store';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function parseCourse(v: unknown): Lab200Course | null {
  if (!isRecord(v)) return null;
  const slug = str(v.slug);
  const title = str(v.title);
  if (!slug || !title) return null;
  const image = str(v.image);
  return {
    slug,
    title,
    summary: str(v.summary) ?? '',
    lessons: typeof v.lessons === 'number' && Number.isFinite(v.lessons) ? v.lessons : null,
    status: str(v.status) ?? '',
    free: v.free === true,
    image: image && /^https:\/\//.test(image) ? image : null,
  };
}

export function parseLab200Snapshot(v: unknown): Lab200Snapshot | null {
  if (!isRecord(v) || !Array.isArray(v.courses)) return null;
  return {
    courses: v.courses.map(parseCourse).filter((x): x is Lab200Course => x !== null),
    syncedAt: str(v.synced_at),
  };
}
