import { AppError } from '../http';

export const ANYMD_BASE_URL = 'https://anymd.cc/api/v1';
export const READS_TAG = 'zuey-reads';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AnyMdDocumentSummary {
  id: string;
  url: string;
  title: string;
  author: string | null;
  description: string | null;
  domain: string | null;
  site: string | null;
  image: string | null;
  published: string | null;
  language: string | null;
  source_kind: string | null;
  tags: string;
  word_count: number | null;
  created_at: number | null;
  updated_at: number | null;
}

export interface AnyMdLibraryPage {
  items: AnyMdDocumentSummary[];
  next_cursor: number | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function optString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function optNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Validates one library item; returns null when required fields are missing. */
export function parseDocumentSummary(v: unknown): AnyMdDocumentSummary | null {
  if (!isRecord(v)) return null;
  const id = optString(v.id);
  const url = optString(v.url);
  if (!id || !url) return null;
  return {
    id,
    url,
    title: optString(v.title) ?? url,
    author: optString(v.author),
    description: optString(v.description),
    domain: optString(v.domain),
    site: optString(v.site),
    image: optString(v.image),
    published: optString(v.published),
    language: optString(v.language),
    source_kind: optString(v.source_kind),
    tags: optString(v.tags) ?? '',
    word_count: optNumber(v.word_count),
    created_at: optNumber(v.created_at),
    updated_at: optNumber(v.updated_at),
  };
}

export function parseLibraryPage(v: unknown): AnyMdLibraryPage {
  if (!isRecord(v) || !Array.isArray(v.items)) {
    throw new AppError(502, 'anymd_bad_response', 'AnyMD returned an unexpected library response shape');
  }
  const items: AnyMdDocumentSummary[] = [];
  for (const raw of v.items) {
    const item = parseDocumentSummary(raw);
    if (item) items.push(item);
  }
  const next = v.next_cursor;
  return { items, next_cursor: typeof next === 'number' && Number.isFinite(next) ? next : null };
}

/** True when the space-separated AnyMD tags string contains the given tag. */
export function hasTag(tags: string, tag: string = READS_TAG): boolean {
  return tags.split(/\s+/).filter(Boolean).includes(tag);
}

async function toAppError(res: Response): Promise<AppError> {
  let upstream = '';
  try {
    const body: unknown = await res.json();
    if (isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string') upstream = body.error.code;
  } catch {
    // Non-JSON error body: the status code alone is enough to classify it.
  }
  const extra = { upstream_status: res.status, ...(upstream ? { upstream_code: upstream } : {}) };
  if (res.status === 401 || res.status === 403) {
    return new AppError(502, 'anymd_unauthorized', 'AnyMD rejected the API key (check ANYMD_API_KEY)', extra);
  }
  if (res.status === 404) return new AppError(502, 'anymd_not_found', 'AnyMD resource not found', extra);
  if (res.status === 429) return new AppError(503, 'anymd_rate_limited', 'AnyMD rate limit reached; retry later', extra);
  return new AppError(502, 'anymd_error', `AnyMD request failed with status ${res.status}`, extra);
}

export class AnyMdClient {
  constructor(
    private apiKey: string,
    private fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private baseUrl: string = ANYMD_BASE_URL,
  ) {}

  private async request(path: string): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json, text/markdown' },
      });
    } catch (err) {
      throw new AppError(502, 'anymd_unreachable', `AnyMD request failed: ${err instanceof Error ? err.message : 'network error'}`);
    }
    if (!res.ok) throw await toAppError(res);
    return res;
  }

  async listLibrary(before?: number | null, limit = 100): Promise<AnyMdLibraryPage> {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (before !== undefined && before !== null) qs.set('before', String(before));
    const res = await this.request(`/library?${qs.toString()}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new AppError(502, 'anymd_bad_response', 'AnyMD returned invalid JSON');
    }
    return parseLibraryPage(body);
  }

  async getMarkdown(id: string): Promise<string> {
    const res = await this.request(`/library/${encodeURIComponent(id)}?format=md`);
    return res.text();
  }
}
