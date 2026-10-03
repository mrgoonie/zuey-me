/**
 * Jev (TypeSafe AI System One) relevance layer for knowledge search and Zuey AI grounding.
 *
 * One request scores up to MAX_JEV_CANDIDATES passages against the query with one Noul question
 * each ("could this passage answer the query?"); the answer is a calibrated probability used to
 * reorder (and, for AI grounding, prune) candidates. Callers pass only text the principal may
 * already read, so the layer never sees withheld paid content. Any failure falls back to the
 * caller's original order: Jev improves ranking but is never required for search to work.
 * Edge-safe: Web APIs only.
 */
import type { RuntimeEnv } from '../../env';

export const TYPESAFE_DEFAULT_API_BASE = 'https://api.typesafe.ai';
export const TYPESAFE_DEFAULT_MODEL = 'jev-latest';
/** TypeSafe answers one question per candidate; 30 keeps a request fast and well under limits. */
export const MAX_JEV_CANDIDATES = 30;
const PASSAGE_CHARS = 1_200;
const TIMEOUT_MS = 4_000;

export interface JevConfig {
  apiKey: string;
  base: string;
  model: string;
}

export interface JevPassage {
  id: string;
  text: string;
}

export const jevRuntime: { fetch: (input: string, init?: RequestInit) => Promise<Response> } = {
  fetch: (input, init) => fetch(input, init),
};

/** TYPESAFEAI_API_KEY enables the layer; TYPESAFE_API_BASE / TYPESAFE_MODEL override the defaults. */
export function jevConfig(env: RuntimeEnv): JevConfig | null {
  const apiKey = (env.TYPESAFEAI_API_KEY ?? '').trim();
  if (!apiKey) return null;
  return {
    apiKey,
    base: (env.TYPESAFE_API_BASE || TYPESAFE_DEFAULT_API_BASE).trim().replace(/\/+$/, ''),
    model: (env.TYPESAFE_MODEL || TYPESAFE_DEFAULT_MODEL).trim(),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Probability (0–1) that each passage answers `query`, keyed by passage id. Returns null when the
 * call fails or times out, so callers keep their own ranking.
 */
export async function jevRelevance(config: JevConfig, query: string, passages: JevPassage[]): Promise<Map<string, number> | null> {
  const batch = passages.slice(0, MAX_JEV_CANDIDATES);
  if (batch.length === 0 || !query.trim()) return new Map();
  // Candidate keys are positional (c0, c1, …) so article ids never become question names.
  const candidates: Record<string, string> = {};
  const questions: Record<string, { type: 'noul'; instructions: string }> = {};
  batch.forEach((p, i) => {
    const key = `c${i}`;
    candidates[key] = p.text.length > PASSAGE_CHARS ? `${p.text.slice(0, PASSAGE_CHARS)}…` : p.text;
    questions[key] = { type: 'noul', instructions: `Could the passage \`candidates.${key}\` answer or directly help with \`query\`?` };
  });
  try {
    const res = await jevRuntime.fetch(`${config.base}/v1/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, state: { query: query.slice(0, 500), candidates }, questions }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`Jev relevance failed with HTTP ${res.status}; keeping the original order`);
      return null;
    }
    const data: unknown = await res.json();
    const answers = isRecord(data) && isRecord(data.answers) ? data.answers : null;
    if (!answers) return null;
    const out = new Map<string, number>();
    batch.forEach((p, i) => {
      const answer = answers[`c${i}`];
      if (isRecord(answer) && typeof answer.noul === 'number' && Number.isFinite(answer.noul)) {
        out.set(p.id, Math.min(1, Math.max(0, answer.noul)));
      }
    });
    return out;
  } catch (err) {
    console.error('Jev relevance unavailable; keeping the original order:', err instanceof Error ? err.message : 'unknown');
    return null;
  }
}

/**
 * Stable reorder by Jev probability (highest first). Items Jev did not score keep their original
 * relative order after the scored ones; ties keep the original order too.
 */
export function orderByRelevance<T>(items: T[], idOf: (item: T) => string, scores: Map<string, number>): T[] {
  return items
    .map((item, index) => ({ item, index, p: scores.get(idOf(item)) }))
    .sort((a, b) => {
      if (a.p === undefined || b.p === undefined) return (a.p === undefined ? 1 : 0) - (b.p === undefined ? 1 : 0) || a.index - b.index;
      return b.p - a.p || a.index - b.index;
    })
    .map(x => x.item);
}
