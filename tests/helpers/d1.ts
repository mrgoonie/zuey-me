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
    return this.runSync();
  }
  runSync(): D1RunResultLike {
    const res = this.db.query(this.sql).run(...this.params);
    return { meta: { changes: res.changes, last_row_id: Number(res.lastInsertRowid) } };
  }
}

/**
 * Real SQLite database with every migration in /migrations applied, exposed through the D1 interface.
 * `beforeMigration` runs before each migration file, so a test can seed data an upgrade must preserve.
 */
export function createTestD1(opts: { beforeMigration?: (file: string, db: Database) => void } = {}): D1DatabaseLike & { raw: Database } {
  const db = new Database(':memory:');
  const dir = path.join(import.meta.dir, '..', '..', 'migrations');
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    opts.beforeMigration?.(file, db);
    db.run(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
  return {
    raw: db,
    prepare(sql: string) {
      return new Statement(db, sql);
    },
    // Same contract as D1 batch: one transaction, rolled back entirely when any statement fails.
    async batch(statements: D1PreparedStatementLike[]) {
      return db.transaction(() => statements.map(s => {
        if (!(s instanceof Statement)) throw new Error('batch expects statements from this database');
        return s.runSync();
      }))();
    },
  };
}

/**
 * `base`, except that the worker dies at the first statement matching `at` (a read, a write alone or a write in a
 * batch): that write never commits, and every later call fails too, so no cleanup runs. It also records each batch's
 * SQL and each write run alone.
 */
export function crashingD1(base: D1DatabaseLike, at: (sql: string) => boolean = () => false) {
  let dead = false;
  const batches: string[][] = [];
  const runs: string[] = [];
  const alive = () => { if (dead) throw new Error('worker crashed'); };
  const crash = (): never => { dead = true; throw new Error('worker crashed'); };
  const read = (sql: string) => { alive(); if (at(sql)) crash(); };
  const sources = new WeakMap<D1PreparedStatementLike, { sql: string; inner: D1PreparedStatementLike }>();
  const wrap = (sql: string, inner: D1PreparedStatementLike): D1PreparedStatementLike => {
    const statement: D1PreparedStatementLike = {
      bind: (...v: unknown[]) => wrap(sql, inner.bind(...v)),
      first: async <T,>() => { read(sql); return inner.first<T>(); },
      all: async <T,>() => { read(sql); return inner.all<T>(); },
      run: async () => {
        alive();
        runs.push(sql);
        if (at(sql)) crash();
        return inner.run();
      },
    };
    sources.set(statement, { sql, inner });
    return statement;
  };
  const d1: D1DatabaseLike = {
    prepare: (sql: string) => wrap(sql, base.prepare(sql)),
    batch: async (statements: D1PreparedStatementLike[]) => {
      alive();
      const list = statements.map(s => {
        const source = sources.get(s);
        if (!source) throw new Error('foreign statement');
        return source;
      });
      batches.push(list.map(s => s.sql));
      if (list.some(s => at(s.sql))) crash();
      return base.batch(list.map(s => s.inner));
    },
  };
  return { d1, batches, runs };
}
