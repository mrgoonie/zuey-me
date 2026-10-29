import { AppError } from '../http';
import { BLOCK_TYPES, LIMITS } from './schema';
import type { BlockType } from './schema';
import { BLOCK_SCHEMA_NOTES, CALLOUT_ICON_EXAMPLE, CARD_EXAMPLE, CODE_BLOCK_EXAMPLE, ICON_BLOCK_EXAMPLE, MATH_EXAMPLE, SECTION_EXAMPLE, TABLE_EXAMPLE, CHART_EXAMPLE, COMPARISON_EXAMPLE, PROGRESS_EXAMPLE, STAT_EXAMPLE, STEPS_EXAMPLE, TABS_EXAMPLE, blockSchemas } from './openapi';
import { iconCatalog } from './icons';

/** Parts of the block_schema answer a caller may ask for. */
export const SCHEMA_PARTS = ['schemas', 'rules', 'limits', 'icons', 'examples'] as const;
export type SchemaPart = (typeof SCHEMA_PARTS)[number];

/** Block type each shipped example demonstrates, so `types` can filter examples too. */
const EXAMPLES: Array<{ key: string; type: BlockType; value: unknown }> = [
  { key: 'icon', type: 'icon', value: ICON_BLOCK_EXAMPLE },
  { key: 'callout_with_icon', type: 'callout', value: CALLOUT_ICON_EXAMPLE },
  { key: 'section', type: 'section', value: SECTION_EXAMPLE },
  { key: 'card', type: 'card', value: CARD_EXAMPLE },
  { key: 'code_diff', type: 'code', value: CODE_BLOCK_EXAMPLE },
  { key: 'math', type: 'math', value: MATH_EXAMPLE },
  { key: 'data_table', type: 'table', value: TABLE_EXAMPLE },
  { key: 'chart_v2', type: 'chart', value: CHART_EXAMPLE },
  { key: 'tabs', type: 'tabs', value: TABS_EXAMPLE },
  { key: 'stat', type: 'stat', value: STAT_EXAMPLE },
  { key: 'timeline', type: 'steps', value: STEPS_EXAMPLE },
  { key: 'comparison', type: 'comparison', value: COMPARISON_EXAMPLE },
  { key: 'progress', type: 'progress', value: PROGRESS_EXAMPLE },
];

const schemaName = (type: string) => `Block${type.charAt(0).toUpperCase()}${type.slice(1)}`;

/** JSON with object keys sorted at every level, so equal content always serialises to equal text. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Drops prose descriptions from a JSON Schema tree; structure, types, enums and limits stay. */
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description').map(([key, v]) => [key, stripDescriptions(v)]));
  }
  return value;
}

function stringList(args: Record<string, unknown>, key: string): string[] | undefined {
  const raw = args[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some(item => typeof item !== 'string')) {
    throw new AppError(400, 'invalid_field', `${key} must be an array of strings`, { field: key });
  }
  return raw as string[];
}

/** Hash of the complete registry (schemas, limits, rules, icon names): changes exactly when the contract does. */
export async function blockSchemaHash(): Promise<string> {
  const full = { block_types: BLOCK_TYPES, limits: LIMITS, rules: BLOCK_SCHEMA_NOTES, schemas: blockSchemas, icons: iconCatalog().names };
  return (await sha256Hex(stableStringify(full))).slice(0, 16);
}

/**
 * The block_schema tool answer. No arguments returns the complete legacy document. `types` narrows
 * schemas and examples to those block types and, unless `include` says otherwise, leaves out rules
 * and icons; `include` picks parts; `compact` drops prose descriptions and shrinks the icon list to
 * names, sizes and tones; `known_hash` short-circuits to `unchanged: true` when the caller already
 * holds the current contract.
 */
export async function describeBlockSchema(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const schemaHash = await blockSchemaHash();
  if (args.known_hash !== undefined) {
    if (typeof args.known_hash !== 'string') throw new AppError(400, 'invalid_field', 'known_hash must be a string', { field: 'known_hash' });
    if (args.known_hash === schemaHash) return { version: 1, schema_hash: schemaHash, unchanged: true };
  }
  const requested = stringList(args, 'types');
  const unknownTypes = requested?.filter(t => !(BLOCK_TYPES as readonly string[]).includes(t));
  if (unknownTypes?.length) {
    throw new AppError(400, 'invalid_field', `Unknown block types: ${unknownTypes.join(', ')}. Valid: ${BLOCK_TYPES.join(', ')}`, { field: 'types' });
  }
  const types = requested ? BLOCK_TYPES.filter(t => requested.includes(t)) : [...BLOCK_TYPES];
  const includeArg = stringList(args, 'include');
  const badParts = includeArg?.filter(p => !(SCHEMA_PARTS as readonly string[]).includes(p));
  if (badParts?.length) {
    throw new AppError(400, 'invalid_field', `Unknown include parts: ${badParts.join(', ')}. Valid: ${SCHEMA_PARTS.join(', ')}`, { field: 'include' });
  }
  if (args.compact !== undefined && typeof args.compact !== 'boolean') throw new AppError(400, 'invalid_field', 'compact must be a boolean', { field: 'compact' });
  const compact = args.compact === true;
  const parts = new Set<SchemaPart>((includeArg as SchemaPart[] | undefined) ?? (requested ? ['schemas', 'limits', 'examples'] : SCHEMA_PARTS));

  const out: Record<string, unknown> = { version: 1, schema_hash: schemaHash, block_types: types };
  if (parts.has('limits')) out.limits = LIMITS;
  if (parts.has('rules')) out.rules = BLOCK_SCHEMA_NOTES;
  if (parts.has('schemas')) {
    const picked = Object.fromEntries(types.map(t => [schemaName(t), blockSchemas[schemaName(t)]]));
    out.schemas = compact ? stripDescriptions(picked) : picked;
  }
  if (parts.has('icons')) {
    const { names, sizes, tones, aligns } = iconCatalog();
    out.icons = compact ? { names, sizes, tones, aligns } : iconCatalog();
  }
  if (parts.has('examples')) out.examples = Object.fromEntries(EXAMPLES.filter(e => types.includes(e.type)).map(e => [e.key, e.value]));
  return out;
}
