import { writeFileSync } from 'node:fs';
import type { Lane, TaskResult } from './types';

export interface CliArgs { base: string; json?: string }

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { base: 'https://zuey.me' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base' && argv[i + 1]) args.base = argv[++i];
    else if (argv[i] === '--json' && argv[i + 1]) args.json = argv[++i];
  }
  args.base = new URL(args.base).origin;
  return args;
}

export function passRate(results: TaskResult[]): { passed: number; total: number; pct: number } {
  const passed = results.filter((r) => r.passed).length;
  return { passed, total: results.length, pct: results.length ? Math.round((passed / results.length) * 100) : 0 };
}

export function formatTable(lane: Lane, base: string, results: TaskResult[]): string {
  const idW = Math.max(4, ...results.map((r) => r.id.length));
  const rows = results.map((r) => `${r.id.padEnd(idW)}  ${r.passed ? 'PASS' : 'FAIL'}  ${r.reason}`);
  const { passed, total, pct } = passRate(results);
  return [`${lane} lane @ ${base}`, `${'task'.padEnd(idW)}  RES   reason`, ...rows, `pass rate: ${passed}/${total} (${pct}%)`].join('\n');
}

export function writeJson(path: string | undefined, lane: Lane, base: string, results: TaskResult[]): void {
  if (!path) return;
  writeFileSync(path, JSON.stringify({ lane, base, at: new Date().toISOString(), rate: passRate(results), results }, null, 2));
}
