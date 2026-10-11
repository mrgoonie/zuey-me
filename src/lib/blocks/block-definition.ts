/**
 * Contract every block type implements once in the block registry (./registry.ts). Server-only facets:
 * the React renderer, the email renderer and the Studio editor stay separate so the browser and the
 * edge worker never load more than they render.
 */
import type { IconName } from './icons';
import type { NestContext } from './nesting';
import type { Block, ImageSize } from './schema';

export type RawBlock = Record<string, unknown>;

/** Field readers shared by every block validator; each records `{path, message}` errors itself. */
export interface BlockValidator {
  /** True while reading an already stored document (lenient recovery instead of rejection). */
  readonly lenient: boolean;
  err(path: string, message: string): void;
  str(o: RawBlock, key: string, path: string, max: number, opts?: { optional?: boolean; nonEmpty?: boolean }): string | undefined;
  /** Required absolute https URL. */
  url(o: RawBlock, key: string, path: string): string | undefined;
  /** Optional https URL: undefined when absent, null when invalid. */
  optUrl(o: RawBlock, key: string, path: string): string | undefined | null;
  strArray(o: RawBlock, key: string, path: string, maxItems: number, maxLen: number, minItems?: number): string[] | undefined;
  /** Optional natural image size (both or neither); null when invalid. */
  imageSize(o: RawBlock, path: string): ImageSize | null;
  /** Allowlisted icon name: undefined when an optional field is absent, null when invalid. */
  iconName(o: RawBlock, key: string, path: string, optional: boolean): IconName | undefined | null;
  /** Validates a nested block list; undefined when it is invalid. */
  blocks(v: unknown, path: string, ctx: NestContext): Block[] | undefined;
  /** Claims a section anchor; false when another section already uses it (with an error, except on a lenient read). */
  claimAnchor(anchor: string, path: string): boolean;
  /** Counts a stored block kept in a reduced form (an embed downgraded to a link, a section without its anchor). */
  degraded(): void;
}

export interface ValidateInput {
  id: string;
  path: string;
  ctx: NestContext;
}

export interface MarkdownContext {
  /** Absolute article URL used for "open on the page" links. */
  articleUrl?: string;
  /** Serializes a nested block list (empty blocks dropped, joined by blank lines). */
  blocks(blocks: Block[]): string;
}

/** OpenAPI 3.1 / JSON Schema object for one block type, without the shared `id` and `type` properties. */
export interface BlockJsonSchema {
  properties: Record<string, unknown>;
  required?: string[];
  /** Extra schema keywords (dependentRequired, examples, …). */
  extra?: Record<string, unknown>;
}

/**
 * One block type. Methods use method syntax on purpose: the registry stores every definition under
 * `BlockDefinition<Block>` and only ever calls one with a block of its own `type`.
 */
export interface BlockDefinition<B extends Block> {
  type: B['type'];
  /** Validates and normalises an untrusted block; undefined when invalid (errors are recorded on `v`). */
  validate(v: BlockValidator, raw: RawBlock, input: ValidateInput): B | undefined;
  /** Markdown for `.md` views, MCP and AI agents. */
  markdown(block: B, ctx: MarkdownContext): string;
  /** Visible text pieces for search indexing and word counts (nested blocks are visited separately). */
  searchText(block: B): string[];
  /** Plain text handed to Zuey AI as grounding (nested blocks are visited separately). */
  aiText(block: B): string;
  /** Reading weight before the minimum of 1; `nested` weighs a nested block list. */
  weight(block: B, nested: (blocks: Block[]) => number): number;
  schema: BlockJsonSchema;
}

export type BlockOf<K extends Block['type']> = Extract<Block, { type: K }>;
