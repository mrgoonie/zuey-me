import { normalizeEmailForSelfCheck } from './codes';

/**
 * One-off fill of `canonical_email` for rows written before migration 0019 (the application writes it on every
 * insert/update since). Used by `scripts/backfill-canonical-emails.ts`, which reads the rows with wrangler and
 * executes the statements built here. Safe to run any number of times.
 */

/** Each table with a canonical mailbox, and the raw email column it is derived from. */
export const CANONICAL_EMAIL_SOURCES = [
  { table: 'users', column: 'email' },
  { table: 'card_subscriptions', column: 'customer_email' },
  { table: 'bookings', column: 'guest_email' },
] as const;

export type CanonicalEmailSource = (typeof CANONICAL_EMAIL_SOURCES)[number];

export interface CanonicalEmailRow {
  id: string;
  email: string | null;
  canonical_email: string | null;
}

/** Every row with an email, and its stored canonical value. Deleted accounts are excluded: their column stays NULL. */
export function canonicalEmailSelectSql(source: CanonicalEmailSource): string {
  const live = source.table === 'users' ? ' AND deleted_at IS NULL' : '';
  return `SELECT id, ${source.column} AS email, canonical_email FROM ${source.table} WHERE ${source.column} IS NOT NULL${live}`;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * UPDATE statements for rows whose `canonical_email` differs from the canonical form of their email. Each one also
 * matches the raw email it was computed from, so a row whose email changed in the meantime is left to the app.
 */
export function canonicalEmailBackfillStatements(source: CanonicalEmailSource, rows: CanonicalEmailRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.email === null) continue;
    const canonical = normalizeEmailForSelfCheck(row.email);
    if (canonical === row.canonical_email) continue;
    out.push(
      `UPDATE ${source.table} SET canonical_email = ${canonical === null ? 'NULL' : quote(canonical)} ` +
      `WHERE id = ${quote(row.id)} AND ${source.column} = ${quote(row.email)};`,
    );
  }
  return out;
}
