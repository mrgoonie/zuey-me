import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { D1DatabaseLike, D1PreparedStatementLike, D1RunResultLike } from '../../src/db/store';

type SqlValue = string | number | bigint | boolean | null | Uint8Array;

function toSqlValue(v: unknown): SqlValue {
  if (v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean' || v === null) return v;
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

class Statement implements D1PreparedStatementLike {
  constructor(private db: Database, private sql: string, private params: SqlValue[] = []) {}
  bind(...values: unknown[]): D1PreparedStatementLike {
    return new Statement(this.db, this.sql, values.map(toSqlValue));
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row: unknown = this.db.query(this.sql).get(...this.params);
    return (row ?? null) as T | null;
  }
  async all<T = Record<string, unknown>>(): Promise<{ results?: T[] }> {
    const rows: unknown[] = this.db.query(this.sql).all(...this.params);
    return { results: rows as T[] };
  }
  async run(): Promise<D1RunResultLike> {
    const res = this.db.query(this.sql).run(...this.params);
    return { meta: { changes: res.changes, last_row_id: Number(res.lastInsertRowid) } };
  }
}

/** Real SQLite database with every migration in /migrations applied, exposed through the D1 interface. */
export function createTestD1(): D1DatabaseLike & { raw: Database } {
  const db = new Database(':memory:');
  const dir = path.join(import.meta.dir, '..', '..', 'migrations');
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    db.run(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
  return {
    raw: db,
    prepare(sql: string) {
      return new Statement(db, sql);
    },
  };
}
