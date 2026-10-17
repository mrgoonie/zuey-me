import { AppError } from '../http';
import { iconCatalog } from './icons';
import { BLOCK_SCHEMA_NOTES, CALLOUT_ICON_EXAMPLE, CARD_EXAMPLE, ICON_BLOCK_EXAMPLE, SECTION_EXAMPLE, blockSchemas } from './openapi';
import { BLOCK_TYPES, DOCUMENT_VERSION, LIMITS } from './schema';
import type { BlockType } from './schema';
import { contentHash } from './stable-json';

export const SCHEMA_SECTIONS = ['types', 'limits', 'rules', 'schemas', 'icons', 'examples'] as const;
export type SchemaSection = (typeof SCHEMA_SECTIONS)[number];

/** Sections returned when the caller narrows the response (types / include / compact) without naming sections. */
const NARROW_DEFAULT: readonly SchemaSection[] = ['types', 'limits', 'rules', 'schemas', 'examples'];

/** Which block type each named example demonstrates (so `types` can drop the others). */
const EXAMPLES: { name: string; type: BlockType; block: unknown }[] = [
  { name: 'icon', type: 'icon', block: ICON_BLOCK_EXAMPLE },
  { name: 'callout_with_icon', type: 'callout', block: CALLOUT_ICON_EXAMPLE },
  { name: 'section', type: 'section', block: SECTION_EXAMPLE },
  { name: 'card', type: 'card', block: CARD_EXAMPLE },
];

const schemaName = (type: string) => `Block${type.charAt(0).toUpperCase()}${type.slice(1)}`;

export interface BlockSchemaQuery {
  types?: BlockType[];
  include?: SchemaSection[];
  compact: boolean;
  /** True when the caller sent none of types / include / compact: the full legacy payload. */
  legacy: boolean;
}

function stringList(raw: unknown, field: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some(v => typeof v !== 'string')) {
    throw new AppError(400, 'invalid_field', `${field} must be an array of strings`, { field });
  }
  return raw as string[];
}

/** Parses block_schema arguments; unknown block types or sections are a 400 that lists the valid values. */
export function parseBlockSchemaQuery(args: Record<string, unknown>): BlockSchemaQuery {
  const types = stringList(args.types, 'types');
  const include = stringList(args.include, 'include');
  if (args.compact !== undefined && typeof args.compact !== 'boolean') {
    throw new AppError(400, 'invalid_field', 'compact must be a boolean', { field: 'compact' });
  }
  const badType = types?.find(t => !(BLOCK_TYPES as readonly string[]).includes(t));
  if (badType !== undefined) throw new AppError(400, 'invalid_field', `Unknown block type "${badType}"; valid: ${BLOCK_TYPES.join(', ')}`, { field: 'types' });
  const badSection = include?.find(s => !(SCHEMA_SECTIONS as readonly string[]).includes(s));
  if (badSection !== undefined) throw new AppError(400, 'invalid_field', `Unknown section "${badSection}"; valid: ${SCHEMA_SECTIONS.join(', ')}`, { field: 'include' });
  return {
    types: types as BlockType[] | undefined,
    include: include as SchemaSection[] | undefined,
    compact: args.compact === true,
    legacy: types === undefined && include === undefined && args.compact === undefined,
  };
}

function unionOf(schemas: unknown[]): string {
  return schemas.map(compactType).join(' | ');
}

/** One-line description of a JSON Schema fragment (types, enums, bounds), dropping prose. */
function compactType(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return 'any';
  const s = schema as Record<string, unknown>;
  if (typeof s.$ref === 'string') return s.$ref.split('/').pop() ?? 'ref';
  if ('const' in s) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return s.enum.map(v => JSON.stringify(v)).join('|');
  if (Array.isArray(s.oneOf)) return unionOf(s.oneOf);
  if (Array.isArray(s.anyOf)) return unionOf(s.anyOf);
  const type = Array.isArray(s.type) ? s.type.join('|') : typeof s.type === 'string' ? s.type : 'any';
  if (type === 'array') {
    const bounds = typeof s.maxItems === 'number' ? `≤${s.maxItems}` : '';
    return `array${bounds}<${compactType(s.items)}>`;
  }
  if (type === 'object' && s.properties && typeof s.properties === 'object') return compactFields(s as { properties: Record<string, unknown>; required?: string[] });
  if (type === 'string' && typeof s.maxLength === 'number') return `string≤${s.maxLength}`;
  if ((type === 'integer' || type === 'number') && (typeof s.minimum === 'number' || typeof s.maximum === 'number')) {
    return `${type} ${s.minimum ?? ''}..${s.maximum ?? ''}`;
  }
  return type;
}

function compactFields(schema: { properties: Record<string, unknown>; required?: string[] }): string {
  const required = new Set(schema.required ?? []);
  const keys = Object.keys(schema.properties).sort();
  return `{${keys.map(k => `${k}${required.has(k) ? '' : '?'}: ${compactType(schema.properties[k])}`).join('; ')}}`;
}

/** Field → type line for one block schema; `id` and `type` are shared by every block and omitted. */
function compactBlock(schema: unknown): { required: string[]; fields: Record<string, string> } {
  const s = schema as { properties: Record<string, unknown>; required?: string[] };
  const fields: Record<string, string> = {};
  for (const key of Object.keys(s.properties).sort()) {
    if (key === 'id' || key === 'type') continue;
    fields[key] = compactType(s.properties[key]);
  }
  return { required: (s.required ?? []).filter(k => k !== 'type').sort(), fields };
}

/** Everything block_schema can describe, hashed so agents can pin a schema version across calls. */
function fullDefinition() {
  return {
    version: DOCUMENT_VERSION, block_types: BLOCK_TYPES, limits: LIMITS, rules: BLOCK_SCHEMA_NOTES, schemas: blockSchemas,
    icons: iconCatalog(), examples: Object.fromEntries(EXAMPLES.map(e => [e.name, e.block])),
  };
}

let hashPromise: Promise<string> | undefined;
/** Digest of the whole block-document definition; changes only when a schema, rule, limit, icon or example does. */
export function blockSchemaHash(): Promise<string> {
  hashPromise ??= contentHash(fullDefinition());
  return hashPromise;
}

/**
 * block_schema payload. With no arguments it is the complete legacy payload (plus `schema_hash`), so existing
 * callers are unaffected. `types` narrows schemas and examples to those block types, `include` picks sections,
 * and `compact` replaces each JSON Schema with a field → type line (and the icon catalogue with names only).
 */
export async function blockSchemaResponse(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const query = parseBlockSchemaQuery(args);
  const schema_hash = await blockSchemaHash();
  if (query.legacy) {
    return {
      version: DOCUMENT_VERSION, schema_hash, block_types: BLOCK_TYPES, limits: LIMITS, rules: BLOCK_SCHEMA_NOTES, schemas: blockSchemas,
      icons: iconCatalog(), examples: { icon: ICON_BLOCK_EXAMPLE, callout_with_icon: CALLOUT_ICON_EXAMPLE, section: SECTION_EXAMPLE, card: CARD_EXAMPLE },
    };
  }
  const sections = new Set(query.include ?? NARROW_DEFAULT);
  const selected = query.types ? BLOCK_TYPES.filter(t => query.types?.includes(t)) : BLOCK_TYPES;
  const out: Record<string, unknown> = { version: DOCUMENT_VERSION, schema_hash, compact: query.compact };
  if (sections.has('types')) out.block_types = selected;
  if (sections.has('limits')) out.limits = LIMITS;
  if (sections.has('rules')) out.rules = BLOCK_SCHEMA_NOTES;
  if (sections.has('schemas')) {
    out.schemas = Object.fromEntries(selected.map(type => {
      const full = blockSchemas[schemaName(type)];
      return [query.compact ? type : schemaName(type), query.compact ? compactBlock(full) : full];
    }));
  }
  if (sections.has('icons')) {
    const icons = iconCatalog();
    out.icons = query.compact ? { names: icons.names, aliases: icons.aliases } : icons;
  }
  if (sections.has('examples')) {
    out.examples = Object.fromEntries(EXAMPLES.filter(e => selected.includes(e.type)).map(e => [e.name, e.block]));
  }
  return out;
}
