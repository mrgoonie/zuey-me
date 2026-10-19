import { ROOT_CONTEXT } from './nesting';
import { blockDefinition } from './registry';
import { isObj } from './definitions/shared';
import type { ArticleDocument } from './schema';
import { Validator, validateWith } from './validator-core';
import type { ValidationResult } from './validator-core';

export type { ValidationError, ValidationResult } from './validator-core';

/** Validates an untrusted document, auto-generating missing block/option ids. */
export function validateDocument(input: unknown): ValidationResult {
  return validateWith(blockDefinition, input);
}

export interface StoredDocumentRead {
  doc: ArticleDocument;
  /** Invalid blocks that were skipped. */
  dropped: number;
  /** Blocks kept in a reduced form: embeds whose stored provider no longer matched their URL (now plain links) and sections that lost an unusable anchor. */
  degraded: number;
}

/**
 * Reads a document that was validated when it was written. A block that fails today's rules is
 * skipped (and a mismatched embed provider becomes `generic`) so one block can never blank a whole
 * document. Returns null only when the envelope itself is unreadable. Writes keep `validateDocument`.
 */
export function readStoredDocument(input: unknown): StoredDocumentRead | null {
  if (!isObj(input) || (input.version !== undefined && input.version !== 1) || !Array.isArray(input.blocks)) return null;
  const v = new Validator(blockDefinition, true);
  const blocks = v.blocks(input.blocks, '$.blocks', ROOT_CONTEXT) ?? [];
  return { doc: { version: 1, blocks }, dropped: v.dropped, degraded: v.degradedCount };
}
