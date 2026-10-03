#!/usr/bin/env node
/**
 * Extract repeated AI workflows from local Claude Code / Codex session logs.
 *
 * Runs on Zuey's machine only (NOT bundled into the site). Raw session text never
 * leaves the machine: only redacted, aggregated candidates are written locally, and
 * nothing is uploaded unless the user confirms (interactive y/n or --yes).
 *
 * Usage:
 *   node extract-workflows.mjs [--since 7d] [--claude-dir DIR] [--codex-dir DIR]
 *        [--out FILE] [--url https://zuey.me] [--min-sessions 3] [--top 10]
 *        [--dry-run] [--yes]
 * Env: ZUEY_API_KEY (admin key, needed for diff + upload), ZUEY_URL (optional).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

/**
 * KEEP IN SYNC with src/lib/workflows/secret-scan.ts (SECRET_PATTERNS).
 * The server blocks publishing on any of these; redacting with the same set means
 * uploaded candidates pass the server scan.
 */
export const SECRET_PATTERNS = [
  { kind: 'private_key', source: '-----BEGIN [A-Z ]*PRIVATE KEY-----', flags: 'g' },
  { kind: 'openai_key', source: '\\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}', flags: 'g' },
  { kind: 'github_token', source: '\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})', flags: 'g' },
  { kind: 'aws_access_key', source: '\\bAKIA[0-9A-Z]{16}\\b', flags: 'g' },
  { kind: 'slack_token', source: '\\bxox[abprs]-[A-Za-z0-9-]{10,}', flags: 'g' },
  { kind: 'bearer_token', source: '\\bBearer\\s+[A-Za-z0-9._~+/=-]{20,}', flags: 'gi' },
  { kind: 'home_path', source: '(?:/Users/[^/\\s]+/|/home/[^/\\s]+/|[A-Za-z]:\\\\Users\\\\[^\\\\\\s]+\\\\)', flags: 'gi' },
  { kind: 'email', source: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', flags: 'g' },
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redacts secrets, emails, home paths and (optionally) the local username.
 * Home paths become `~/`; everything else becomes `[REDACTED:<kind>]`.
 */
export function redact(text, options = {}) {
  let out = String(text);
  for (const p of SECRET_PATTERNS) {
    out = out.replace(new RegExp(p.source, p.flags), p.kind === 'home_path' ? '~/' : `[REDACTED:${p.kind}]`);
  }
  const username = options.username;
  if (typeof username === 'string' && username.length >= 3) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(username)}\\b`, 'gi'), '[user]');
  }
  return out;
}

/** True when the text still matches any server-side pattern. */
export function containsSecret(text) {
  return SECRET_PATTERNS.some(p => new RegExp(p.source, p.flags.replace('g', '')).test(text));
}

// ---------------- argument parsing ----------------

export function parseSince(value, now = Date.now()) {
  const m = /^(\d+)([hdw])$/.exec(String(value || '').trim());
  if (!m) throw new Error(`Invalid --since "${value}" (use e.g. 12h, 7d, 2w)`);
  const unit = { h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2]];
  return now - Number(m[1]) * unit;
}

function parseArgs(argv) {
  const home = os.homedir();
  const args = {
    since: '7d',
    claudeDir: path.join(home, '.claude', 'projects'),
    codexDir: path.join(home, '.codex', 'sessions'),
    out: path.resolve('workflow-candidates.json'),
    url: process.env.ZUEY_URL || 'https://zuey.me',
    minSessions: 3,
    top: 10,
    dryRun: false,
    yes: false,
    help: false,
    sinceMs: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    if (a === '--since') args.since = next();
    else if (a === '--claude-dir') args.claudeDir = path.resolve(next());
    else if (a === '--codex-dir') args.codexDir = path.resolve(next());
    else if (a === '--out') args.out = path.resolve(next());
    else if (a === '--url') args.url = next();
    else if (a === '--min-sessions') args.minSessions = Math.max(1, Number.parseInt(next(), 10) || 1);
    else if (a === '--top') args.top = Math.max(1, Number.parseInt(next(), 10) || 1);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  args.sinceMs = parseSince(args.since);
  args.url = args.url.replace(/\/+$/, '');
  return args;
}

// ---------------- session parsing ----------------

function listJsonl(dir, sinceMs) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          if (fs.statSync(full).mtimeMs >= sinceMs) out.push(full);
        } catch {
          /* unreadable file: skip */
        }
      }
    }
  }
  return out;
}

/** Reduces a shell command to a stable "program subcommand" token (no arguments, no paths). */
export function normalizeCommand(command) {
  const cmd = Array.isArray(command) ? command.join(' ') : String(command || '');
  // Codex wraps commands as ["bash","-lc","..."]: keep the inner script.
  const inner = cmd.replace(/^(?:ba|z)?sh\s+-l?c\s+/, '').replace(/^['"]|['"]$/g, '');
  const first = inner.split(/&&|\|\||;|\|/)[0].trim();
  const words = first.split(/\s+/).filter(w => w && !/^[A-Z_]+=/.test(w));
  if (words.length === 0) return 'shell';
  const prog = path.basename(words[0]);
  const sub = words[1] && /^[a-z][a-z0-9:-]*$/.test(words[1]) ? ` ${words[1]}` : '';
  return `${prog}${sub}`.slice(0, 40);
}

function toolToken(name, input) {
  const n = String(name || 'tool');
  if (/^(bash|shell|local_shell|exec_command)$/i.test(n)) {
    const cmd = input && typeof input === 'object' ? input.command ?? input.cmd : undefined;
    return `$ ${normalizeCommand(cmd)}`;
  }
  return n.slice(0, 40);
}

function parseArgsJson(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string') return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Extracts the ordered tool tokens of one JSONL line (Claude Code or Codex format). */
export function tokensFromEntry(entry) {
  const tokens = [];
  if (!entry || typeof entry !== 'object') return tokens;
  // Claude Code: { type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } }
  const content = entry.message && Array.isArray(entry.message.content) ? entry.message.content : [];
  for (const block of content) {
    if (block && block.type === 'tool_use') tokens.push(toolToken(block.name, block.input));
  }
  // Codex: { type: 'response_item', payload: { type: 'function_call', name, arguments } } (or un-wrapped)
  const item = entry.payload && typeof entry.payload === 'object' ? entry.payload : entry;
  if (item.type === 'function_call' || item.type === 'custom_tool_call') {
    tokens.push(toolToken(item.name, parseArgsJson(item.arguments ?? item.input)));
  } else if (item.type === 'local_shell_call') {
    tokens.push(toolToken('local_shell', item.action ?? {}));
  }
  return tokens;
}

/** Reads one session file; unparseable lines are counted and skipped. */
export function readSessionTokens(file) {
  const tokens = [];
  let badLines = 0;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { tokens, badLines: 0, unreadable: true };
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      tokens.push(...tokensFromEntry(JSON.parse(line)));
    } catch {
      badLines++;
    }
  }
  // Collapse immediate repeats (e.g. 5x Read in a row) so n-grams describe steps, not retries.
  return { tokens: tokens.filter((t, i) => t !== tokens[i - 1]), badLines, unreadable: false };
}

// ---------------- mining ----------------

/** Counts in how many sessions each 3..5-gram of tool tokens appears. */
export function mineNgrams(sessions, { minSessions = 3, top = 10, minN = 3, maxN = 5 } = {}) {
  const counts = new Map();
  for (const tokens of sessions) {
    const seen = new Set();
    for (let n = minN; n <= maxN; n++) {
      for (let i = 0; i + n <= tokens.length; i++) {
        const gram = tokens.slice(i, i + n);
        if (new Set(gram).size < 2) continue; // ignore single-tool loops
        seen.add(gram.join('\u0001'));
      }
    }
    for (const key of seen) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const ranked = [...counts.entries()]
    .filter(([, c]) => c >= minSessions)
    .map(([key, c]) => ({ steps: key.split('\u0001'), sessions: c }))
    .sort((a, b) => b.sessions * b.steps.length - a.sessions * a.steps.length);
  const chosen = [];
  for (const cand of ranked) {
    const joined = cand.steps.join('\u0001');
    if (chosen.some(c => c.steps.join('\u0001').includes(joined))) continue;
    chosen.push(cand);
    if (chosen.length >= top) break;
  }
  return chosen;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workflow';
}

export function toCandidate(gram, sinceLabel, username) {
  const r = s => redact(s, { username });
  const steps = gram.steps.map(r);
  const tools = [...new Set(steps.map(s => (s.startsWith('$ ') ? s.slice(2).split(' ')[0] : s)))].slice(0, 20);
  const name = r(`Auto: ${steps.slice(0, 3).join(' → ')}`).slice(0, 120);
  return {
    name,
    slug: `auto-${slugify(steps.join(' '))}`.slice(0, 80),
    summary: r(`Repeated ${steps.length}-step tool sequence seen in ${gram.sessions} sessions (last ${sinceLabel}). Edit before publishing.`),
    tools,
    trigger: r(`Observed automatically in local Claude Code / Codex sessions (last ${sinceLabel}).`),
    steps: steps.map(title => ({ title: title.slice(0, 160) })),
    metrics: [{ label: 'Sessions observed', value: String(gram.sessions) }],
    tags: ['auto-extracted'],
  };
}

// ---------------- server interaction ----------------

async function api(args, method, p, body) {
  const key = process.env.ZUEY_API_KEY;
  if (!key) throw new Error('ZUEY_API_KEY is not set');
  const res = await fetch(`${args.url}${p}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.success !== true) {
    const err = json && json.error ? json.error : {};
    const e = new Error(`${method} ${p} failed (${res.status}): ${err.code || ''} ${err.message || ''}`.trim());
    e.details = err;
    throw e;
  }
  return json.data;
}

const DIFF_FIELDS = ['name', 'summary', 'tools', 'trigger', 'steps', 'metrics', 'tags'];

export function diffCandidate(candidate, existing) {
  if (!existing) return { action: 'create', changes: DIFF_FIELDS };
  const changes = DIFF_FIELDS.filter(f => JSON.stringify(candidate[f]) !== JSON.stringify(existing[f]));
  return { action: changes.length ? 'update' : 'unchanged', changes, revision: existing.revision };
}

function ask(rl, q) {
  return new Promise(resolve => rl.question(q, a => resolve(/^y(es)?$/i.test(a.trim()))));
}

// ---------------- main ----------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }
  const username = os.userInfo().username;
  const files = [...listJsonl(args.claudeDir, args.sinceMs), ...listJsonl(args.codexDir, args.sinceMs)];
  let badLines = 0;
  const sessions = [];
  for (const f of files) {
    const s = readSessionTokens(f);
    badLines += s.badLines;
    if (s.tokens.length) sessions.push(s.tokens);
  }
  console.log(`Scanned ${files.length} session files (${sessions.length} with tool use, ${badLines} unparseable lines skipped).`);

  const grams = mineNgrams(sessions, { minSessions: args.minSessions, top: args.top });
  const candidates = grams.map(g => toCandidate(g, args.since, username)).filter(c => !containsSecret(JSON.stringify(c)));
  fs.writeFileSync(args.out, JSON.stringify({ generated_at: new Date().toISOString(), since: args.since, candidates }, null, 2));
  console.log(`Wrote ${candidates.length} redacted candidates to ${args.out}`);
  if (candidates.length === 0) return;

  let existing = new Map();
  if (process.env.ZUEY_API_KEY) {
    try {
      const list = await api(args, 'GET', '/api/v1/workflows?include_drafts=1');
      existing = new Map((Array.isArray(list) ? list : []).map(w => [w.slug, w]));
    } catch (e) {
      console.warn(`Could not fetch server drafts: ${e.message}`);
    }
  } else {
    console.warn('ZUEY_API_KEY not set: diff assumes no server drafts and upload is disabled.');
  }

  const plan = candidates.map(c => ({ candidate: c, ...diffCandidate(c, existing.get(c.slug)) }));
  console.log('\nDiff vs server drafts:');
  for (const p of plan) {
    const mark = { create: '+', update: '~', unchanged: '=' }[p.action];
    console.log(`  ${mark} ${p.candidate.slug}  ${p.action}${p.action === 'update' ? ` [${p.changes.join(', ')}] (rev ${p.revision})` : ''}`);
    if (p.action !== 'unchanged') p.candidate.steps.forEach((s, i) => console.log(`      ${i + 1}. ${s.title}`));
  }

  if (args.dryRun) {
    console.log('\n--dry-run: nothing uploaded.');
    return;
  }
  if (!process.env.ZUEY_API_KEY) return;

  const rl = args.yes ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const p of plan) {
      if (p.action === 'unchanged') continue;
      const ok = args.yes || (await ask(rl, `Upload ${p.action} draft "${p.candidate.slug}"? [y/N] `));
      if (!ok) continue;
      try {
        if (p.action === 'create') {
          await api(args, 'POST', '/api/v1/workflows', { ...p.candidate, expected_revision: 0 });
        } else {
          const { slug: _slug, ...fields } = p.candidate;
          await api(args, 'PUT', `/api/v1/workflows/${p.candidate.slug}`, { ...fields, expected_revision: p.revision });
        }
        console.log(`  saved draft ${p.candidate.slug} (not published — publish from Studio)`);
      } catch (e) {
        console.error(`  ${e.message}`);
      }
    }
  } finally {
    rl?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
