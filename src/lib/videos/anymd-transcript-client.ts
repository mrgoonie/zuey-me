/**
 * Fetches a YouTube video's Markdown (metadata + timestamped transcript) from AnyMD's convert API.
 * Called once per edition at add/refetch time; the result is stored in D1 so page renders never call out.
 */
import { ANYMD_BASE_URL } from '../reads/anymd-client';
import type { FetchLike } from '../reads/anymd-client';
import { watchUrl } from './youtube-url';

const TIMEOUT_MS = 45_000;

export class TranscriptFetchError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'TranscriptFetchError';
  }
}

function describeStatus(status: number): string {
  if (status === 401 || status === 403) return 'AnyMD rejected the API key';
  if (status === 402) return 'AnyMD monthly credits are exhausted';
  if (status === 429) return 'AnyMD rate limit reached; retry later';
  if (status === 422 || status === 400) return 'AnyMD could not read this video URL';
  return `AnyMD failed with HTTP ${status}`;
}

/**
 * Returns AnyMD's Markdown for the video. Works without a key (small anonymous quota);
 * with ANYMD_API_KEY the call is billed to the account (YouTube = 3 credits, cached hits free).
 */
export async function fetchVideoMarkdown(
  youtubeId: string,
  opts: { apiKey?: string; fresh?: boolean; fetchImpl?: FetchLike; baseUrl?: string } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/markdown' };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(`${opts.baseUrl ?? ANYMD_BASE_URL}/convert`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: watchUrl(youtubeId), format: 'markdown', save: false, frontmatter: true, fresh: Boolean(opts.fresh) }),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new TranscriptFetchError(aborted ? 'AnyMD timed out' : 'AnyMD is unreachable', 504);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new TranscriptFetchError(describeStatus(res.status), res.status);
  const text = await res.text();
  if (!text.trim()) throw new TranscriptFetchError('AnyMD returned an empty document', 502);
  return text;
}
