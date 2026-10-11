/** Guards and text helpers shared by block definitions. */
import { inlineToPlain } from '../inline';

export type Obj = Record<string, unknown>;

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && list.some(item => item === v);
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
