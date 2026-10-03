/**
 * Interactive artifacts in AI replies: ```zuey-interactive fences holding JSON
 * {title, html, css, js, height?, caption?}. Every candidate is validated by the shared
 * article block schema, so an artifact can later be attached to a draft unchanged.
 */
import type { InteractiveBlock } from '../blocks/schema';
import { validateDocument } from '../blocks/validate';

export const INTERACTIVE_FENCE = 'zuey-interactive';
export const MAX_ARTIFACTS_PER_MESSAGE = 3;

const FENCE_RE = /(`{3,})zuey-interactive[^\S\r\n]*\r?\n([\s\S]*?)\r?\n\1/g;

export interface ExtractedArtifacts {
  blocks: InteractiveBlock[];
  /** Human-readable reasons for fences that were rejected (shown to the user). */
  errors: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validates one untrusted interactive block through the shared document validator. */
export function validateInteractiveBlock(input: unknown): { ok: true; block: InteractiveBlock } | { ok: false; errors: string[] } {
  if (!isRecord(input)) return { ok: false, errors: ['artifact must be a JSON object'] };
  const res = validateDocument({ version: 1, blocks: [{ ...input, type: 'interactive', id: undefined }] });
  if (!res.ok) return { ok: false, errors: res.errors.map(e => `${e.path.replace('$.blocks[0]', 'artifact')} ${e.message}`) };
  const block = res.doc.blocks[0];
  if (!block || block.type !== 'interactive') return { ok: false, errors: ['artifact is not an interactive block'] };
  return { ok: true, block };
}

export function extractArtifacts(content: string): ExtractedArtifacts {
  const blocks: InteractiveBlock[] = [];
  const errors: string[] = [];
  for (const m of content.matchAll(FENCE_RE)) {
    if (blocks.length >= MAX_ARTIFACTS_PER_MESSAGE) {
      errors.push(`only ${MAX_ARTIFACTS_PER_MESSAGE} interactive blocks are kept per reply`);
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[2]);
    } catch {
      errors.push('interactive block is not valid JSON');
      continue;
    }
    const res = validateInteractiveBlock(parsed);
    if (res.ok) blocks.push(res.block);
    else errors.push(...res.errors.slice(0, 3));
  }
  return { blocks, errors };
}
