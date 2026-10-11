import { BLOCK_TYPES, LIMITS } from './schema';
import type { ArticleDocument, Block, BlockType, ImageSize } from './schema';
import type { BlockValidator } from './block-definition';
import { resolveIconName } from './icons';
import type { IconName } from './icons';
import { ROOT_CONTEXT, nestingError } from './nesting';
import type { NestContext } from './nesting';
import { blockDefinition } from './registry';
import { ID_RE, isInt, isObj, isOneOf } from './definitions/shared';
import type { Obj } from './definitions/shared';

export interface ValidationError { path: string; message: string }
export type ValidationResult = { ok: true; doc: ArticleDocument } | { ok: false; errors: ValidationError[] };

const MAX_ERRORS = 50;

function randomId(prefix: string): string {
  return prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

/** Document-level state (ids, anchors, counts) plus the field readers every block definition uses. */
class Validator implements BlockValidator {
  errors: ValidationError[] = [];
  /** Blocks skipped by a lenient (stored-document) read. */
  dropped = 0;
  /** Embeds whose provider was downgraded to `generic` by a lenient read. */
  degradedCount = 0;
  private ids = new Set<string>();
  private anchors = new Set<string>();
  private count = 0;

  /** Lenient mode reads documents that were already stored: invalid blocks are skipped instead of failing the document. */
  constructor(readonly lenient = false) {}

  err(path: string, message: string): void {
    if (this.errors.length < MAX_ERRORS) this.errors.push({ path, message });
  }

  degraded(): void {
    this.degradedCount += 1;
  }

  str(o: Obj, key: string, path: string, max: number, opts: { optional?: boolean; nonEmpty?: boolean } = {}): string | undefined {
    const v = o[key];
    if (v === undefined || v === null) {
      if (!opts.optional) this.err(`${path}.${key}`, 'is required');
      return undefined;
    }
    if (typeof v !== 'string') { this.err(`${path}.${key}`, 'must be a string'); return undefined; }
    if (v.length > max) { this.err(`${path}.${key}`, `must be at most ${max} characters`); return undefined; }
    if (opts.nonEmpty && !v.trim()) { this.err(`${path}.${key}`, 'must not be empty'); return undefined; }
    return v;
  }

  url(o: Obj, key: string, path: string): string | undefined {
    const v = this.str(o, key, path, LIMITS.url, { nonEmpty: true });
    if (v === undefined) return undefined;
    try {
      if (new URL(v).protocol === 'https:') return v;
    } catch { /* reported below */ }
    this.err(`${path}.${key}`, 'must be an absolute https:// URL');
    return undefined;
  }

  optUrl(o: Obj, key: string, path: string): string | undefined | null {
    if (o[key] === undefined || o[key] === null || o[key] === '') return undefined;
    return this.url(o, key, path) ?? null;
  }

  strArray(o: Obj, key: string, path: string, maxItems: number, maxLen: number, minItems = 0): string[] | undefined {
    const v = o[key];
    if (!Array.isArray(v)) { this.err(`${path}.${key}`, 'must be an array of strings'); return undefined; }
    if (v.length < minItems || v.length > maxItems) {
      this.err(`${path}.${key}`, `must contain ${minItems}–${maxItems} items`);
      return undefined;
    }
    const out: string[] = [];
    v.forEach((item, i) => {
      if (typeof item !== 'string') this.err(`${path}.${key}[${i}]`, 'must be a string');
      else if (item.length > maxLen) this.err(`${path}.${key}[${i}]`, `must be at most ${maxLen} characters`);
      else out.push(item);
    });
    return out.length === v.length ? out : undefined;
  }

  /** Optional natural size of an image: both `width` and `height` as positive integers, or neither. `null` = invalid. */
  imageSize(o: Obj, path: string): ImageSize | null {
    const absent = (v: unknown) => v === undefined || v === null;
    if (absent(o.width) && absent(o.height)) return {};
    const { width, height } = o;
    if (!isInt(width, 1, LIMITS.imagePixels) || !isInt(height, 1, LIMITS.imagePixels)) {
      this.err(`${path}.${isInt(width, 1, LIMITS.imagePixels) ? 'height' : 'width'}`,
        `width and height must both be integers from 1 to ${LIMITS.imagePixels}, or both omitted`);
      return null;
    }
    return { width, height };
  }

  /**
   * Canonical allowlisted icon name (aliases resolve to it). Returns undefined when an optional
   * field is absent and null when the value is invalid (an error is recorded).
   */
  iconName(o: Obj, key: string, path: string, optional: boolean): IconName | undefined | null {
    const raw = o[key];
    if ((raw === undefined || raw === null || raw === '') && optional) return undefined;
    const name = resolveIconName(raw);
    if (name) return name;
    // Never echo the raw value: it may be long or contain markup.
    this.err(`${path}.${key}`, raw === undefined || raw === null
      ? 'is required; pick a name from the icon allowlist (block_schema → icons.names)'
      : 'is not an allowlisted icon name; pick one from the icon allowlist (block_schema → icons.names)');
    return null;
  }

  claimAnchor(anchor: string, path: string): boolean {
    if (this.anchors.has(anchor)) {
      // A lenient read keeps the section and lets the caller drop the anchor.
      if (!this.lenient) this.err(path, `duplicate section anchor "${anchor}"`);
      return false;
    }
    this.anchors.add(anchor);
    return true;
  }

  id(o: Obj, path: string): string | undefined {
    const v = o.id;
    let id: string;
    if (v === undefined || v === null || v === '') {
      do id = randomId('b_'); while (this.ids.has(id));
    } else if (typeof v !== 'string' || !ID_RE.test(v)) {
      this.err(`${path}.id`, 'must match [A-Za-z0-9_-]{1,64}');
      return undefined;
    } else {
      id = v;
    }
    if (this.ids.has(id)) { this.err(`${path}.id`, `duplicate block id "${id}"`); return undefined; }
    this.ids.add(id);
    return id;
  }

  blocks(v: unknown, path: string, ctx: NestContext): Block[] | undefined {
    if (!Array.isArray(v)) { this.err(path, 'must be an array of blocks'); return undefined; }
    const out: Block[] = [];
    let failed = false;
    v.forEach((item, i) => {
      const mark = this.errors.length;
      const block = this.block(item, `${path}[${i}]`, ctx);
      if (block) out.push(block);
      else if (this.lenient) { this.errors.length = mark; this.dropped += 1; }
      else failed = true;
    });
    return failed ? undefined : out;
  }

  block(v: unknown, path: string, ctx: NestContext): Block | undefined {
    this.count += 1;
    if (this.count === LIMITS.totalBlocks + 1) this.err(path, `document exceeds ${LIMITS.totalBlocks} blocks`);
    if (this.count > LIMITS.totalBlocks) return undefined;
    if (!isObj(v)) { this.err(path, 'must be an object'); return undefined; }
    const type = v.type;
    if (!isOneOf<BlockType>(BLOCK_TYPES, type)) {
      this.err(`${path}.type`, `unknown block type ${JSON.stringify(type)}; expected one of ${BLOCK_TYPES.join(', ')}`);
      return undefined;
    }
    const misplaced = nestingError(type, ctx);
    if (misplaced) { this.err(`${path}.type`, misplaced); return undefined; }
    const id = this.id(v, path);
    const before = this.errors.length;
    const block = blockDefinition(type).validate(this, v, { id: id ?? '', path, ctx });
    if (id !== undefined && block && this.errors.length === before) return block;
    // A rejected block must not reserve its id for a later block (matters for lenient reads).
    if (id !== undefined) this.ids.delete(id);
    return undefined;
  }
}

/** Validates an untrusted document, auto-generating missing block/option ids. */
export function validateDocument(input: unknown): ValidationResult {
  const v = new Validator();
  if (!isObj(input)) return { ok: false, errors: [{ path: '$', message: 'document must be an object {version: 1, blocks: []}' }] };
  if (input.version !== undefined && input.version !== 1) v.err('$.version', 'must be 1');
  const blocks = v.blocks(input.blocks, '$.blocks', ROOT_CONTEXT);
  if (v.errors.length || !blocks) return { ok: false, errors: v.errors.length ? v.errors : [{ path: '$.blocks', message: 'invalid' }] };
  return { ok: true, doc: { version: 1, blocks } };
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
  const v = new Validator(true);
  const blocks = v.blocks(input.blocks, '$.blocks', ROOT_CONTEXT) ?? [];
  return { doc: { version: 1, blocks }, dropped: v.dropped, degraded: v.degradedCount };
}
