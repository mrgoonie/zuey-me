/**
 * Optional semantic retrieval: Workers AI embeddings (`AI` binding) + Cloudflare Vectorize (`VECTORIZE`).
 *
 * The binding is optional. Without both bindings, search is BM25-only and reports `semantic: false`.
 * To enable it in production:
 *   wrangler vectorize create zuey-knowledge --dimensions=1024 --metric=cosine
 *   wrangler vectorize create-metadata-index zuey-knowledge --property-name=tier --type=string
 *   wrangler vectorize create-metadata-index zuey-knowledge --property-name=locale --type=string
 * then bind it as `VECTORIZE` (Pages → Settings → Bindings, or a `[[vectorize]]` block in wrangler.toml)
 * and call POST /api/v1/search/reindex once. Metadata indexes must exist before vectors are inserted,
 * because the access-tier filter is applied inside the Vectorize query (authorization before ranking).
 */
import type { RuntimeEnv, WorkersAiLike } from '../../env';

export const EMBEDDING_MODEL = '@cf/baai/bge-m3';
/** bge-m3 accepts long inputs, but shorter chunks embed faster and keep the topic focused. */
const MAX_EMBED_CHARS = 4_000;

export interface VectorMatch { id: string; score: number }

export interface VectorizeLike {
  query(vector: number[], options: { topK: number; filter?: Record<string, unknown>; returnMetadata?: boolean | string }): Promise<unknown>;
  upsert(vectors: Array<{ id: string; values: number[]; metadata?: Record<string, string> }>): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

export interface SemanticBackend {
  ai: WorkersAiLike;
  index: VectorizeLike;
}

function hasMethods(v: unknown, names: string[]): boolean {
  if (typeof v !== 'object' || v === null) return false;
  return names.every(n => n in v && typeof Reflect.get(v, n) === 'function');
}

function isVectorize(v: unknown): v is VectorizeLike {
  return hasMethods(v, ['query', 'upsert', 'deleteByIds']);
}

/** Returns the semantic backend when both optional bindings are present. */
export function semanticBackend(env: RuntimeEnv | undefined): SemanticBackend | null {
  if (!env?.AI) return null;
  // VECTORIZE is an optional binding that is not part of the shared RuntimeEnv contract; read it with a guard.
  const index: unknown = Reflect.get(env, 'VECTORIZE');
  return isVectorize(index) ? { ai: env.AI, index } : null;
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every(n => typeof n === 'number');
}

/** Embeds texts with bge-m3; throws when the model response has an unexpected shape. */
export async function embedTexts(ai: WorkersAiLike, texts: string[]): Promise<number[][]> {
  const res = await ai.run(EMBEDDING_MODEL, { text: texts.map(t => t.slice(0, MAX_EMBED_CHARS)) });
  const data = typeof res === 'object' && res !== null && 'data' in res ? Reflect.get(res, 'data') : null;
  if (!Array.isArray(data) || data.length !== texts.length || !data.every(isNumberArray)) {
    throw new Error('Unexpected embedding response shape');
  }
  return data;
}

export function parseMatches(res: unknown): VectorMatch[] {
  const matches = typeof res === 'object' && res !== null && 'matches' in res ? Reflect.get(res, 'matches') : null;
  if (!Array.isArray(matches)) return [];
  const out: VectorMatch[] = [];
  for (const m of matches) {
    if (typeof m !== 'object' || m === null) continue;
    const id: unknown = Reflect.get(m, 'id');
    const score: unknown = Reflect.get(m, 'score');
    if (typeof id === 'string' && typeof score === 'number') out.push({ id, score });
  }
  return out;
}

export function vectorId(articleId: string, locale: string, tier: string): string {
  return `${articleId}:${locale}:${tier}`;
}

export function parseVectorId(id: string): { articleId: string; locale: string; tier: string } | null {
  const parts = id.split(':');
  return parts.length === 3 ? { articleId: parts[0], locale: parts[1], tier: parts[2] } : null;
}
