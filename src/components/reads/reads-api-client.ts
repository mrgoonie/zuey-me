/** Client-side validation of GET /api/v1/reads (untrusted JSON → typed values). */
import { isRecord } from '../home/storage';
import type { ReadItem, ReadsSourceFacet } from '../../lib/reads/store';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export interface ReadsListView {
  items: ReadItem[];
  sources: ReadsSourceFacet[];
  lastSyncedAt: string | null;
}

export function parseReadItem(v: unknown): ReadItem | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  const url = str(v.url);
  if (!id || !url || !/^https?:\/\//.test(url)) return null;
  return {
    id,
    url,
    title: str(v.title) ?? url,
    author: str(v.author),
    description: str(v.description),
    domain: str(v.domain),
    site: str(v.site),
    image: str(v.image),
    source_kind: str(v.source_kind),
    language: str(v.language),
    published: str(v.published),
    tags: str(v.tags) ?? '',
    word_count: num(v.word_count),
    content_hash: str(v.content_hash),
    summary: str(v.summary),
    visible: v.visible !== false,
    anymd_updated_at: num(v.anymd_updated_at),
    synced_at: str(v.synced_at),
    created_at: str(v.created_at) ?? '',
  };
}

function parseSource(v: unknown): ReadsSourceFacet | null {
  if (!isRecord(v)) return null;
  const kind = str(v.source_kind);
  return kind ? { source_kind: kind, count: num(v.count) ?? 0 } : null;
}

export function parseReadsList(v: unknown): ReadsListView | null {
  if (!isRecord(v) || !Array.isArray(v.items)) return null;
  return {
    items: v.items.map(parseReadItem).filter((x): x is ReadItem => x !== null),
    sources: Array.isArray(v.sources) ? v.sources.map(parseSource).filter((x): x is ReadsSourceFacet => x !== null) : [],
    lastSyncedAt: str(v.last_synced_at),
  };
}
