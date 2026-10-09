// One-off backfill of `canonical_email` (migration 0019) on users, card_subscriptions and bookings.
//
//   bun scripts/backfill-canonical-emails.ts --local
//   bun scripts/backfill-canonical-emails.ts --remote --dry-run   # writes the SQL file, executes nothing
//   bun scripts/backfill-canonical-emails.ts --remote
//
// Remote runs need CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN of the account that owns zuey_me_db, and a Time
// Travel bookmark taken first (docs/env-setup.vi.md, sections 0 and 12). Idempotent: rows already correct are skipped.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CanonicalEmailRow } from '../src/lib/referrals/canonical-email-backfill';
import {
  CANONICAL_EMAIL_SOURCES, canonicalEmailBackfillStatements, canonicalEmailSelectSql,
} from '../src/lib/referrals/canonical-email-backfill';

const DATABASE = 'zuey_me_db';
const args = new Set(process.argv.slice(2));
const target = args.has('--remote') ? '--remote' : args.has('--local') ? '--local' : null;
const dryRun = args.has('--dry-run');
if (!target) {
  console.error('Pass --local or --remote (optionally --dry-run).');
  process.exit(1);
}
if (target === '--remote' && (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN)) {
  console.error('Export CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (from .env) before a remote run.');
  process.exit(1);
}

function wrangler(extra: string[]): string {
  return execFileSync('bunx', ['wrangler', 'd1', 'execute', DATABASE, target!, ...extra], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function query(sql: string): CanonicalEmailRow[] {
  const out = JSON.parse(wrangler(['--json', '--command', sql])) as Array<{ results?: CanonicalEmailRow[] }>;
  return out.flatMap(r => r.results ?? []);
}

const statements: string[] = [];
for (const source of CANONICAL_EMAIL_SOURCES) {
  const rows = query(canonicalEmailSelectSql(source));
  const updates = canonicalEmailBackfillStatements(source, rows);
  console.log(`${source.table}: ${rows.length} rows read, ${updates.length} to update`);
  statements.push(...updates);
}

if (!statements.length) {
  console.log('Nothing to backfill.');
  process.exit(0);
}

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zuey-canonical-email-')), 'backfill.sql');
fs.writeFileSync(file, `${statements.join('\n')}\n`, 'utf8');
if (dryRun) {
  console.log(`Dry run: ${statements.length} statements written to ${file}`);
  process.exit(0);
}
wrangler(['--file', file, '-y']);
console.log(`Applied ${statements.length} updates. Run again to confirm: it should report nothing to backfill.`);
