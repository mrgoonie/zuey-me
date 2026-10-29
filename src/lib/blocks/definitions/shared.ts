/** Guards and text helpers shared by block definitions. */
import type { BlockValidator, RawBlock } from '../block-definition';
import { inlineToPlain } from '../inline';

export type Obj = Record<string, unknown>;

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isOneOf<T extends string | number>(list: readonly T[], v: unknown): v is T {
  return list.some(item => item === v);
}

export function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** Plain text of an optional inline-Markdown field ('' when absent). */
export function plain(s: string | undefined): string {
  return s ? inlineToPlain(s) : '';
}

/** Visible length of an optional inline-Markdown field. */
export function plainLength(s: string | undefined): number {
  return s ? inlineToPlain(s).length : 0;
}

/** Optional boolean option: true, or undefined for false/absent; null when it is not a boolean. */
export function flag(v: BlockValidator, raw: RawBlock, key: string, path: string): true | undefined | null {
  const value = raw[key];
  if (value === undefined || value === null || value === false) return undefined;
  if (value === true) return true;
  v.err(`${path}.${key}`, 'must be a boolean');
  return null;
}
