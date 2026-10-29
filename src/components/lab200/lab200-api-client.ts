/** Client-side validation of GET /api/v1/lab200 (untrusted JSON → typed values), with the same validators as the server. */
import { isRecord } from '../home/storage';
import { parseLab200Items } from '../../lib/lab200/catalog';
import type { Lab200Catalog } from '../../lib/lab200/store';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function parseLab200Catalog(v: unknown): Lab200Catalog | null {
  if (!isRecord(v) || !Array.isArray(v.courses)) return null;
  return {
    courses: { items: parseLab200Items('courses', v.courses), locale: str(v.courses_locale), syncedAt: str(v.synced_at) },
    learningPaths: {
      items: parseLab200Items('learningPaths', v.learning_paths),
      locale: str(v.learning_paths_locale),
      syncedAt: str(v.learning_paths_synced_at),
    },
  };
}
