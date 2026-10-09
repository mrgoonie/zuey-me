#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const VERSION = '1.2.0';
const DEFAULT_API_URL = 'https://zuey.me';

// ---------------------------------------------------------------------------
// Config: OS config dir, file mode 0600 (directory 0700). Keys are only ever sent in headers.
// ---------------------------------------------------------------------------

function configDir() {
  if (process.env.ZUEY_CONFIG_DIR) return process.env.ZUEY_CONFIG_DIR;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'zuey');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'zuey');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'zuey');
}

const CONFIG_FILE = path.join(configDir(), 'config.json');
const LEGACY_CONFIG_FILE = path.join(os.homedir(), '.zuey', 'config.json');

function readJsonFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Environment variables win over the saved file so CI/agents never need to write secrets to disk. */
function loadConfig() {
  const saved = readJsonFile(CONFIG_FILE) || readJsonFile(LEGACY_CONFIG_FILE) || {};
  return {
    apiUrl: (process.env.ZUEY_API_URL || (typeof saved.apiUrl === 'string' && saved.apiUrl) || DEFAULT_API_URL).replace(/\/+$/, ''),
    apiKey: process.env.ZUEY_API_KEY || (typeof saved.apiKey === 'string' ? saved.apiKey : ''),
  };
}

function saveConfig(cfg) {
  const dir = path.dirname(CONFIG_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  // mode only applies on creation; tighten an existing file too (no-op on Windows ACLs).
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* best effort on filesystems without POSIX modes */ }
}

function maskKey(key) {
  return key ? `${key.slice(0, 7)}…` : '(none)';
}

function validateApiUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`Invalid --url: ${raw}`); }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('--url must be https (http is allowed only for localhost) so the key is never sent in clear text');
  }
  return url.origin;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, code, message, requestId) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

async function requestApi(endpoint, method = 'GET', body = null, { auth = true } = {}) {
  const config = loadConfig();
  const headers = { Accept: 'application/json', 'User-Agent': `zuey-cli/${VERSION}` };
  if (body !== null) headers['Content-Type'] = 'application/json';
  if (auth && config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  let res;
  try {
    res = await fetch(`${config.apiUrl}${endpoint}`, { method, headers, body: body !== null ? JSON.stringify(body) : undefined });
  } catch (err) {
    throw new ApiError(0, 'network_error', `Cannot reach ${config.apiUrl}: ${err.message}`, null);
  }
  const requestId = res.headers.get('x-request-id');
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const err = data && typeof data.error === 'object' && data.error ? data.error : {};
    const code = typeof err.code === 'string' ? err.code : (typeof data?.error === 'string' ? data.error : `http_${res.status}`);
    const message = typeof err.message === 'string' ? err.message : (res.statusText || 'Request failed');
    throw new ApiError(res.status, code, message, requestId);
  }
  return data;
}

function requireKey() {
  if (!loadConfig().apiKey) {
    console.error('Not logged in. Run "zuey login" and paste a personal API key (create one at https://zuey.me/account#keys).');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

/** Reads a secret from the TTY without echoing it, or one line from piped stdin. */
function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', chunk => { buf += chunk; });
      stdin.on('end', () => resolve(buf.split(/\r?\n/)[0].trim()));
      stdin.on('error', reject);
      return;
    }
    process.stderr.write(prompt);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') { // Ctrl+C
          stdin.setRawMode(false);
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : null;
}

function positional(args, from) {
  const out = [];
  for (let i = from; i < args.length; i++) {
    if (args[i].startsWith('--')) { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

const SAIGON = 'Asia/Ho_Chi_Minh';
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('vi-VN', { timeZone: SAIGON, dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

// ---------------------------------------------------------------------------
// Article rendering (block document -> plain text)
// ---------------------------------------------------------------------------

function renderBlocks(blocks, out = []) {
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || typeof b !== 'object') continue;
    switch (b.type) {
      case 'heading': out.push('', `${'#'.repeat(b.level || 2)} ${b.text || ''}`, ''); break;
      case 'paragraph': out.push(b.text || '', ''); break;
      case 'list': (b.items || []).forEach((it, i) => out.push(`${b.style === 'number' ? `${i + 1}.` : '-'} ${it}`)); out.push(''); break;
      case 'checklist': (b.items || []).forEach(it => out.push(`[${it && it.checked ? 'x' : ' '}] ${it && it.text ? it.text : ''}`)); out.push(''); break;
      case 'quote': out.push(`> ${b.text || ''}${b.cite ? ` — ${b.cite}` : ''}`, ''); break;
      case 'callout': out.push(`! ${b.text || ''}`, ''); break;
      case 'code': out.push('```' + (b.language || ''), b.code || '', '```', ''); break;
      case 'divider': out.push('---', ''); break;
      case 'image': out.push(`[image] ${b.alt || ''} ${b.url || ''}`.trim(), ''); break;
      case 'embed': out.push(`[embed] ${b.url || ''}`, ''); break;
      case 'table':
        out.push((b.headers || []).join(' | '));
        (b.rows || []).forEach(r => out.push((r || []).join(' | ')));
        out.push('');
        break;
      case 'layout': for (const child of b.children || []) renderBlocks(child && child.blocks, out); break;
      default:
        if (typeof b.text === 'string') out.push(b.text, '');
        else out.push(`[${b.type || 'block'}] (view on the web)`, '');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`
Zuey.me CLI v${VERSION} — your zuey.me membership from the terminal (and admin tools for the owner)

USAGE:
  zuey <command> [options]

MEMBER COMMANDS (personal key zk_…, created at https://zuey.me/account#keys):
  login [--url <URL>]                  Paste a personal API key (input hidden; saved with 0600 permissions)
  logout                               Forget the saved key
  whoami                               Show the account, plans and key scopes
  articles list [--tag <t>]            List articles you can read
  articles read <slug>                 Print an article as plain text
  search <query>                       Search article titles, excerpts and tags
  chat "<message>" [--session <id>]    Ask Zuey AI, streamed (chat:write scope + AI plan; --session continues)
  plans                                Show membership plans and VND prices
  subscribe <plan> --months <n>        Create an order and print the VietQR bank-transfer details
  keys                                 How to create, rotate and revoke keys
  mcp config                           Print MCP client configuration snippets
  videos list [--q <query>]            List Zueytube videos, or search titles and transcripts
  videos get <id>                      Print a video's editions, transcript and related articles

ADMIN COMMANDS (admin API key):
  login --key <API_KEY> [--url <URL>]  Save an admin key non-interactively (prefer ZUEY_API_KEY env)
  profile view | update [options]      Inspect or update the profile
  links list | add | delete | reorder  Manage link cards
  theme view | set <name>              Switch theme (ivory | dark | minimal | glass)
  mcp                                  Stdio MCP bridge to /api/mcp
  videos add <url> [--locale vi|en] [--pair <video_id>] [--title <t>]
                                       Add a YouTube video (transcript fetched once via AnyMD)
  videos refetch <youtube_id>          Fetch the transcript again
  videos feature <video_id> [--off]    Pin a video to the top (or unpin)
  videos delete <id>                   Delete a video (video_id) or one edition (youtube_id)

ENVIRONMENT:
  ZUEY_API_KEY    Key used instead of the saved one (recommended for CI and agents)
  ZUEY_API_URL    API origin (default ${DEFAULT_API_URL})
  ZUEY_CONFIG_DIR Override the config directory

Config file: ${CONFIG_FILE}
`);
}

async function cmdLogin(args) {
  const urlArg = flag(args, '--url');
  const apiUrl = urlArg ? validateApiUrl(urlArg) : loadConfig().apiUrl;
  let apiKey = flag(args, '--key');
  if (!apiKey) apiKey = await readSecret('Paste your zuey.me API key (input hidden): ');
  if (!apiKey || /\s/.test(apiKey) || apiKey.length > 200) {
    console.error('No valid key entered. Create one at https://zuey.me/account#keys');
    process.exit(1);
  }
  // Verify before saving so a typo is not persisted.
  process.env.ZUEY_API_URL = apiUrl;
  process.env.ZUEY_API_KEY = apiKey;
  let who = null;
  try {
    const res = await requestApi('/api/v1/me');
    who = res && res.data ? res.data : null;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403) && apiKey.startsWith('zk_')) {
      console.error(`Key rejected (${err.code}): ${err.message}`);
      process.exit(1);
    }
    // Admin keys have no member account (/api/v1/me answers 403); keep them.
  }
  saveConfig({ apiUrl, apiKey });
  console.log(`Logged in to ${apiUrl}${who && who.email ? ` as ${who.email}` : ''} with key ${maskKey(apiKey)}`);
  console.log(`Config saved to ${CONFIG_FILE} (mode 0600)`);
}

async function cmdWhoami() {
  requireKey();
  const cfg = loadConfig();
  const { data } = await requestApi('/api/v1/me');
  console.log(`Email:        ${data.email}${data.email_verified ? '' : ' (unverified)'}`);
  if (data.name) console.log(`Name:         ${data.name}`);
  console.log(`Plans:        ${(data.plans || []).join(', ') || 'none (free)'}`);
  console.log(`Entitlements: ${(data.entitlements || []).join(', ') || 'none'}`);
  if (data.auth) console.log(`Auth:         ${data.auth.via}${data.auth.scopes ? ` · scopes: ${data.auth.scopes.join(', ')}` : ''}`);
  console.log(`Key:          ${maskKey(cfg.apiKey)} @ ${cfg.apiUrl}`);
}

async function fetchArticles() {
  const res = await requestApi('/api/v1/articles', 'GET', null, { auth: Boolean(loadConfig().apiKey) });
  return Array.isArray(res && res.data) ? res.data : [];
}

function printArticleList(list) {
  if (list.length === 0) { console.log('No articles found.'); return; }
  for (const a of list) {
    const lock = a.access === 'knowledges' ? ' [Knowledges]' : '';
    console.log(`${a.slug}${lock}\n  ${a.title}${a.excerpt ? `\n  ${a.excerpt}` : ''}${a.tags && a.tags.length ? `\n  #${a.tags.join(' #')}` : ''}\n`);
  }
}

async function cmdArticles(args) {
  const sub = args[1] || 'list';
  if (sub === 'list') {
    const tag = flag(args, '--tag');
    const list = await fetchArticles();
    printArticleList(tag ? list.filter(a => Array.isArray(a.tags) && a.tags.includes(tag)) : list);
    return;
  }
  if (sub === 'read') {
    const slug = args[2];
    if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      console.error('Usage: zuey articles read <slug>');
      process.exit(1);
    }
    const { data } = await requestApi(`/api/v1/articles/${encodeURIComponent(slug)}`, 'GET', null, { auth: Boolean(loadConfig().apiKey) });
    console.log(`# ${data.title}\n`);
    if (data.excerpt) console.log(`${data.excerpt}\n`);
    console.log(renderBlocks(data.document && data.document.blocks).join('\n').replace(/\n{3,}/g, '\n\n').trim());
    if (data.truncated) {
      console.log(`\n— This is a preview. The full article needs the Knowledges plan: run "zuey plans" or open ${loadConfig().apiUrl}/pricing`);
    }
    console.log(`\n${loadConfig().apiUrl}/articles/${data.slug}`);
    return;
  }
  console.error('Usage: zuey articles list [--tag <t>] | zuey articles read <slug>');
  process.exit(1);
}

function printVideoTranscriptStatus(e) {
  return `${e.transcript_status}${e.transcript_error ? ` (${e.transcript_error})` : ''}`;
}

async function cmdVideos(args) {
  const sub = args[1] || 'list';
  const usage = 'Usage: zuey videos list [--q <query>] | get <id> | add <url> [--locale vi|en] [--pair <video_id>] [--title <t>] | refetch <youtube_id> | feature <video_id> [--off] | delete <id>';
  const id = args[2];
  const needId = () => {
    if (!id || id.startsWith('--')) {
      console.error(usage);
      process.exit(1);
    }
    return encodeURIComponent(id);
  };

  if (sub === 'list') {
    const q = flag(args, '--q');
    if (q) {
      const { data } = await requestApi(`/api/v1/videos?q=${encodeURIComponent(q)}&limit=20`, 'GET');
      const results = Array.isArray(data.results) ? data.results : [];
      console.log(`${results.length} match(es) for "${q}"\n`);
      for (const h of results) {
        console.log(`- [${h.locale.toUpperCase()}] ${h.title}  (${h.video_id})`);
        if (h.snippet) console.log(`    ${h.snippet.replace(/\*\*/g, '')}`);
        console.log(`    ${h.url}`);
      }
      return;
    }
    const { data } = await requestApi('/api/v1/videos?limit=200', 'GET');
    const items = Array.isArray(data.items) ? data.items : [];
    console.log(`${items.length} video(s)\n`);
    for (const v of items) {
      console.log(`${v.featured ? '★ ' : ''}${v.id}`);
      for (const e of v.editions) console.log(`  [${e.locale.toUpperCase()}] ${e.title}  ${e.watch_url}  transcript: ${printVideoTranscriptStatus(e)}`);
    }
    return;
  }
  if (sub === 'get') {
    const { data } = await requestApi(`/api/v1/videos/${needId()}`, 'GET');
    const { video, related_articles: related } = data;
    for (const e of video.editions) {
      console.log(`# [${e.locale.toUpperCase()}] ${e.title}\n`);
      console.log(`${e.watch_url}\n${loadConfig().apiUrl}/videos?v=${e.youtube_id}\n`);
      if (e.description) console.log(`${e.description}\n`);
      console.log(e.transcript ? `## Transcript\n\n${e.transcript}\n` : `Transcript: ${printVideoTranscriptStatus(e)}\n`);
    }
    if (Array.isArray(related) && related.length > 0) {
      console.log('## Related articles\n');
      for (const a of related) console.log(`- ${a.title}  ${a.url}`);
    }
    return;
  }

  requireKey();
  if (sub === 'add') {
    const url = id;
    if (!url || url.startsWith('--')) {
      console.error(usage);
      process.exit(1);
    }
    const body = { url, locale: flag(args, '--locale') || 'vi' };
    const pair = flag(args, '--pair');
    const title = flag(args, '--title');
    if (pair) body.pair_with = pair;
    if (title) body.title = title;
    console.log('Adding video and fetching its transcript (this can take up to a minute)…');
    const { data } = await requestApi('/api/v1/videos', 'POST', body, { auth: true });
    console.log(`Added ${data.youtube_id} to ${data.video.id} — transcript: ${data.transcript_status}${data.transcript_error ? ` (${data.transcript_error})` : ''}`);
    return;
  }
  if (sub === 'refetch') {
    const { data } = await requestApi(`/api/v1/videos/${needId()}/refetch`, 'POST', {}, { auth: true });
    console.log(`Transcript: ${data.transcript_status}${data.transcript_error ? ` (${data.transcript_error})` : ''}`);
    return;
  }
  if (sub === 'feature') {
    await requestApi(`/api/v1/videos/${needId()}`, 'PATCH', { featured: !args.includes('--off') }, { auth: true });
    console.log(args.includes('--off') ? 'Unpinned.' : 'Pinned to the top.');
    return;
  }
  if (sub === 'delete') {
    await requestApi(`/api/v1/videos/${needId()}`, 'DELETE', null, { auth: true });
    console.log('Deleted.');
    return;
  }
  console.error(usage);
  process.exit(1);
}

async function cmdSearch(args) {
  const query = positional(args, 1).join(' ').trim().toLowerCase();
  if (!query) {
    console.error('Usage: zuey search <query>');
    process.exit(1);
  }
  // No full-text search endpoint is exposed yet: match the article index (titles, excerpts, tags) locally.
  const words = query.split(/\s+/);
  const hits = (await fetchArticles()).filter(a => {
    const hay = `${a.title || ''} ${a.excerpt || ''} ${(a.tags || []).join(' ')} ${a.slug || ''}`.toLowerCase();
    return words.every(w => hay.includes(w));
  });
  console.log(`Matches in article titles, excerpts and tags (body text is not searched): ${hits.length}\n`);
  printArticleList(hits);
}

async function cmdChat(args) {
  requireKey();
  const message = positional(args, 1).join(' ').trim();
  if (!message) {
    console.error('Usage: zuey chat "<message>" [--session <id>]');
    process.exit(1);
  }
  let sessionId = flag(args, '--session');
  if (!sessionId) {
    const created = await requestApi('/api/v1/chat/sessions', 'POST', { title: message.slice(0, 80) });
    sessionId = created && created.data && created.data.id;
    if (!sessionId) throw new ApiError(0, 'bad_response', 'The server did not return a chat session id', null);
  }

  const config = loadConfig();
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  let res;
  try {
    res = await fetch(`${config.apiUrl}/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', 'User-Agent': `zuey-cli/${VERSION}`, Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ message }),
      signal: abort.signal,
    });
  } catch (err) {
    throw new ApiError(0, 'network_error', `Cannot reach ${config.apiUrl}: ${err.message}`, null);
  }
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    const e = data && typeof data.error === 'object' && data.error ? data.error : {};
    throw new ApiError(res.status, typeof e.code === 'string' ? e.code : `http_${res.status}`, typeof e.message === 'string' ? e.message : res.statusText, res.headers.get('x-request-id'));
  }

  // SSE: `sources`, `delta`*, then `done` or `error`.
  const decoder = new TextDecoder();
  let buf = '';
  let sources = [];
  let failed = null;
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const event = (frame.match(/^event: (.+)$/m) || [])[1];
        const raw = (frame.match(/^data: (.+)$/m) || [])[1];
        if (!event || !raw) continue;
        const data = JSON.parse(raw);
        if (event === 'sources') sources = Array.isArray(data.sources) ? data.sources : [];
        else if (event === 'delta') process.stdout.write(data.text || '');
        else if (event === 'error') failed = data;
      }
    }
  } catch (err) {
    if (!abort.signal.aborted) throw err;
  }
  process.stdout.write('\n');
  if (sources.length) {
    console.log('\nSources:');
    for (const s of sources) console.log(`  - ${s.title || s.slug || ''}${s.url ? ` ${s.url}` : ''}`);
  }
  console.error(`\nSession: ${sessionId} (continue with --session ${sessionId})`);
  if (failed) {
    console.error(`Error (${failed.code}): ${failed.message}`);
    process.exit(1);
  }
}

async function cmdPlans() {
  const { data } = await requestApi('/api/v1/plans', 'GET', null, { auth: false });
  for (const p of data.plans || []) {
    console.log(`${p.id} — ${p.name}: $${(p.price_usd_cents / 100).toFixed(2)}/month`);
    if (p.tagline) console.log(`  ${p.tagline}`);
    for (const price of p.prices || []) {
      if (typeof price.amount_vnd === 'number') console.log(`  ${price.months} month(s): ${price.amount_vnd.toLocaleString('vi-VN')} ₫`);
    }
    console.log('');
  }
  if (!data.billing_configured) console.log('Note: bank-transfer checkout is not configured on this server right now.');
  console.log('Subscribe: zuey subscribe <plan> --months <1|3|6|12>');
}

async function cmdSubscribe(args) {
  requireKey();
  const plan = positional(args, 1)[0];
  const months = Number(flag(args, '--months') || '1');
  if (!plan || !Number.isInteger(months) || ![1, 3, 6, 12].includes(months)) {
    console.error('Usage: zuey subscribe <plan> --months <1|3|6|12>   (see "zuey plans")');
    process.exit(1);
  }
  const { data } = await requestApi('/api/v1/billing/orders', 'POST', { plan, months });
  console.log(`Order ${data.code}: ${data.plan_name} × ${data.months} month(s) — ${Number(data.amount_vnd).toLocaleString('vi-VN')} ₫`);
  console.log(`Pay before: ${fmtDate(data.expires_at)} (Asia/Ho_Chi_Minh)`);
  const t = data.transfer;
  if (t) {
    console.log('\nBank transfer (VietQR):');
    console.log(`  Bank:            ${t.bank_code}`);
    console.log(`  Account:         ${t.bank_account}`);
    console.log(`  Amount:          ${Number(t.amount).toLocaleString('vi-VN')} ₫`);
    console.log(`  Transfer content: ${t.transfer_content}   (must match exactly)`);
    console.log(`  QR image:        ${t.qr_url}`);
  }
  console.log(`\nThe plan activates automatically when the transfer arrives. Status: ${loadConfig().apiUrl}/billing/${encodeURIComponent(data.code)}`);
}

function cmdKeys() {
  const { apiUrl } = loadConfig();
  console.log(`Personal API keys are created, rotated and revoked in the browser only (keys can never mint keys):
  ${apiUrl}/account#keys

Then run "zuey login" and paste the key, or export ZUEY_API_KEY=<key>.`);
}

function cmdMcpConfig() {
  const { apiUrl } = loadConfig();
  const url = `${apiUrl}/mcp`;
  console.log(`# Remote MCP over OAuth (recommended: sign in and approve in the browser, no key on disk)
{
  "mcpServers": {
    "zuey": { "type": "http", "url": "${url}" }
  }
}

# Claude Code
claude mcp add --transport http zuey ${url}

# Header auth with a personal key (clients without OAuth support)
{
  "mcpServers": {
    "zuey": {
      "type": "http",
      "url": "${url}",
      "headers": { "Authorization": "Bearer <YOUR_ZK_KEY>" }
    }
  }
}

Manage connected apps: ${apiUrl}/account#connected-apps`);
}

async function startStdioMcp() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let id = null;
    try {
      const rpcReq = JSON.parse(line);
      id = rpcReq && rpcReq.id !== undefined ? rpcReq.id : null;
      const res = await requestApi('/api/mcp', 'POST', rpcReq);
      process.stdout.write(JSON.stringify(res) + '\n');
    } catch (err) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id }) + '\n');
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const cmd = args[0];

  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    console.log(`zuey-cli v${VERSION}`);
    return;
  }

  if (cmd === 'login') return cmdLogin(args);
  if (cmd === 'logout') {
    if (fs.existsSync(CONFIG_FILE)) fs.rmSync(CONFIG_FILE);
    if (fs.existsSync(LEGACY_CONFIG_FILE)) fs.rmSync(LEGACY_CONFIG_FILE);
    console.log('Saved key removed. Revoke it at https://zuey.me/account#keys if it may have leaked.');
    return;
  }
  if (cmd === 'whoami') return cmdWhoami();
  if (cmd === 'articles') return cmdArticles(args);
  if (cmd === 'search') return cmdSearch(args);
  if (cmd === 'chat') return cmdChat(args);
  if (cmd === 'plans') return cmdPlans();
  if (cmd === 'subscribe') return cmdSubscribe(args);
  if (cmd === 'keys') return cmdKeys();
  if (cmd === 'videos') return cmdVideos(args);

  if (cmd === 'mcp') {
    if (args[1] === 'config') return cmdMcpConfig();
    await startStdioMcp();
    return;
  }

  if (cmd === 'profile') {
    const sub = args[1] || 'view';
    if (sub === 'view') {
      const res = await requestApi('/api/v1/profile');
      console.log('\n--- ZUEY.ME PROFILE ---');
      console.log(`Name:   ${res.data.name} (${res.data.handle})`);
      console.log(`Email:  ${res.data.email}`);
      console.log(`Avatar: ${res.data.avatar_url}`);
      console.log(`Theme:  ${res.data.theme}`);
      console.log(`Bio EN: ${res.data.intro_en}`);
      console.log(`Bio VI: ${res.data.intro_vi}\n`);
      return;
    }

    if (sub === 'update') {
      const updates = {};
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--name' && args[i + 1]) updates.name = args[++i];
        if (args[i] === '--intro-en' && args[i + 1]) updates.intro_en = args[++i];
        if (args[i] === '--intro-vi' && args[i + 1]) updates.intro_vi = args[++i];
        if (args[i] === '--avatar' && args[i + 1]) updates.avatar_url = args[++i];
        if (args[i] === '--theme' && args[i + 1]) updates.theme = args[++i];
      }
      const res = await requestApi('/api/v1/profile', 'PUT', updates);
      console.log('✓ Profile updated successfully:', res.data.name);
      return;
    }
  }

  if (cmd === 'links') {
    const sub = args[1] || 'list';
    if (sub === 'list') {
      const res = await requestApi('/api/v1/links');
      const targetSec = flag(args, '--section');
      const list = targetSec ? res.data.filter(l => l.section === targetSec) : res.data;

      console.log(`\n--- LINKS (${list.length}) ---`);
      list.forEach((l, idx) => {
        console.log(`[${idx + 1}] (${l.section.toUpperCase()}) ${l.title_en}`);
        console.log(`    ID:   ${l.id}`);
        console.log(`    URL:  ${l.url}`);
        if (l.subtitle_en) console.log(`    Desc: ${l.subtitle_en}`);
      });
      console.log();
      return;
    }

    if (sub === 'add') {
      const item = { section: 'products', title_en: '', url: '', subtitle_en: '', title_vi: '', icon: '' };
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--section' && args[i + 1]) item.section = args[++i];
        if (args[i] === '--title' && args[i + 1]) item.title_en = args[++i];
        if (args[i] === '--title-vi' && args[i + 1]) item.title_vi = args[++i];
        if (args[i] === '--url' && args[i + 1]) item.url = args[++i];
        if (args[i] === '--subtitle' && args[i + 1]) item.subtitle_en = args[++i];
        if (args[i] === '--icon' && args[i + 1]) item.icon = args[++i];
      }
      if (!item.title_en || !item.url) {
        console.error('Error: --title and --url are required.');
        process.exit(1);
      }
      const res = await requestApi('/api/v1/links', 'POST', item);
      console.log('✓ Link card created:', res.data.id, `(${res.data.title_en})`);
      return;
    }

    if (sub === 'delete') {
      const id = args[2];
      if (!id) {
        console.error('Error: Link ID required.');
        process.exit(1);
      }
      await requestApi(`/api/v1/links/${encodeURIComponent(id)}`, 'DELETE');
      console.log('✓ Link card deleted successfully:', id);
      return;
    }

    if (sub === 'reorder') {
      const orderIds = args.slice(2);
      if (orderIds.length === 0) {
        console.error('Error: Please provide link IDs in desired order.');
        process.exit(1);
      }
      await requestApi('/api/v1/links/reorder', 'POST', { order: orderIds });
      console.log('✓ Links reordered successfully.');
      return;
    }
  }

  if (cmd === 'theme') {
    const sub = args[1] || 'view';
    if (sub === 'view') {
      const res = await requestApi('/api/v1/theme');
      console.log(`Current theme: ${res.data.theme}`);
      return;
    }
    if (sub === 'set') {
      const theme = args[2];
      if (!theme) {
        console.error('Error: Theme name required (ivory | dark | minimal | glass)');
        process.exit(1);
      }
      await requestApi('/api/v1/theme', 'PUT', { theme });
      console.log(`✓ Theme changed to: ${theme}`);
      return;
    }
  }

  console.error(`Unknown command: ${cmd}. Run "zuey --help" for available commands.`);
  process.exit(1);
}

main().catch(err => {
  if (err instanceof ApiError) {
    console.error(`Error ${err.status ? `${err.status} ` : ''}${err.code}: ${err.message}${err.requestId ? ` (request id ${err.requestId})` : ''}`);
  } else {
    console.error('Error:', err.message);
  }
  process.exit(1);
});
