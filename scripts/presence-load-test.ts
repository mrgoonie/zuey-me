#!/usr/bin/env bun
/**
 * Local load test for the presence Worker (workers/presence). It opens WebSocket connections to
 * `/v1/connect`, keeps them alive with heartbeats, and measures connect time, broadcast latency seen by
 * subscribers, HTTP read latency under load, and how a mass disconnect lands in the aggregate `active`
 * count. Every check compares the Worker's answer with the number of sessions this script holds open.
 *
 * Start the Worker first with the repo's wrangler 4.x (wrangler 3.x crashes locally):
 *   bunx wrangler@4.151.2 dev --config workers/presence/wrangler.toml --port 8788
 *
 * Tickets are signed here with PRESENCE_TICKET_SECRET read from workers/presence/.dev.vars at runtime.
 * The value is never printed. Local use only: do not point this at a deployed Worker.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  ACTIVITY_CATEGORIES,
  PRESENCE_INTERNAL_HEADER,
  PRESENCE_SUBPROTOCOL,
  type PresenceDiagnostics,
  type PresenceSnapshot,
} from '../src/lib/presence/contract';
import { signPresenceInternal } from '../src/lib/presence/internal-auth';
import { signPresenceTicket } from '../src/lib/presence/ticket';

const TICKET_TTL_MS = 110_000;
const CONNECT_TIMEOUT_MS = 15_000;
const CONVERGE_TIMEOUT_MS = 15_000;
const SAMPLE_INTERVAL_MS = 5_000;
const DEFAULT_DEV_VARS = fileURLToPath(new URL('../workers/presence/.dev.vars', import.meta.url));
/** Subscribers wait this long for a snapshot showing a probe's count change. */
const PROBE_TIMEOUT_MS = 10_000;

const USAGE = `Usage: bun scripts/presence-load-test.ts [options]

Local load test for the presence Worker. Start the Worker first:
  bunx wrangler@4.151.2 dev --config workers/presence/wrangler.toml --port 8788

Phases: cap probes (per-IP 20 and per-key 10), ramp to --connections, hold for --hold-seconds with
heartbeats, open/close probes measured at subscribers and HTTP reads, churn --churn sockets at once,
then teardown and a check that the count returns to 0.

Options:
  --url <base URL>            Worker base URL (default http://localhost:8788)
  --origin <origin>           Origin header on WebSocket connects (default http://localhost:4321; needs PRESENCE_DEV_ORIGINS=1)
  --dev-vars <path>           File holding PRESENCE_TICKET_SECRET (default workers/presence/.dev.vars)
  --connections <n>           Visitor sockets opened during the ramp (default 500)
  --ramp-per-second <n>       Target connect rate during the ramp (default 50)
  --subscribers <n>           Visitor sockets that send {t:'sub'} and record snapshots (default 20)
  --heartbeat-ms <ms>         Heartbeat interval per socket, random phase (default 25000)
  --hold-seconds <s>          Steady-state hold with heartbeats, probes and HTTP reads (default 180)
  --probes <n>                Open/close probe events during the hold (default 12, alternating open and close)
  --http-requests <n>         GET /v1/snapshot and /v1/history requests during the hold, alternating (default 200)
  --http-concurrency <n>      Parallel HTTP requests (default 4)
  --churn <n>                 Sockets closed in one burst after the hold (default 100)
  --skip-cap-check            Skip the per-IP and per-key cap probes
  --worker-pid <pid>          Sample RSS and CPU of this process and its children every 5 s (e.g. the workerd PID)
  --out <path>                Also write the full JSON result to this path
  -h, --help                  Show this help

Virtual browsers each send their own CF-Connecting-IP (10.x.y.z), because the Worker keys its per-IP cap
on that header; without it every socket shares one IP and the 20-per-IP cap rejects most of them. The cap
probes use TEST-NET addresses (192.0.2.x). The result is printed as JSON on stdout.`;

const { values } = parseArgs({
  options: {
    help: { type: 'boolean', short: 'h', default: false },
    url: { type: 'string', default: 'http://localhost:8788' },
    origin: { type: 'string', default: 'http://localhost:4321' },
    'dev-vars': { type: 'string', default: DEFAULT_DEV_VARS },
    connections: { type: 'string', default: '500' },
    'ramp-per-second': { type: 'string', default: '50' },
    subscribers: { type: 'string', default: '20' },
    'heartbeat-ms': { type: 'string', default: '25000' },
    'hold-seconds': { type: 'string', default: '180' },
    probes: { type: 'string', default: '12' },
    'http-requests': { type: 'string', default: '200' },
    'http-concurrency': { type: 'string', default: '4' },
    churn: { type: 'string', default: '100' },
    'skip-cap-check': { type: 'boolean', default: false },
    'worker-pid': { type: 'string' },
    out: { type: 'string' },
  },
  strict: true,
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

function intFlag(name: string, raw: string, min: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}, got "${raw}"`);
  return n;
}

const config = {
  base: values.url.replace(/\/$/, ''),
  wsBase: values.url.replace(/\/$/, '').replace(/^http/, 'ws'),
  origin: values.origin,
  connections: intFlag('connections', values.connections, 1),
  rampPerSecond: intFlag('ramp-per-second', values['ramp-per-second'], 1),
  subscribers: intFlag('subscribers', values.subscribers, 1),
  heartbeatMs: intFlag('heartbeat-ms', values['heartbeat-ms'], 1000),
  holdSeconds: intFlag('hold-seconds', values['hold-seconds'], 0),
  probes: intFlag('probes', values.probes, 0),
  httpRequests: intFlag('http-requests', values['http-requests'], 0),
  httpConcurrency: intFlag('http-concurrency', values['http-concurrency'], 1),
  churn: intFlag('churn', values.churn, 0),
  capCheck: !values['skip-cap-check'],
  workerPid: values['worker-pid'] === undefined ? null : intFlag('worker-pid', values['worker-pid'], 1),
};
if (config.subscribers > config.connections) throw new Error('--subscribers cannot exceed --connections');
if (config.subscribers + config.churn > config.connections) throw new Error('--subscribers + --churn cannot exceed --connections');

function readTicketSecret(path: string): string {
  const line = readFileSync(path, 'utf8').split('\n').find((l) => l.startsWith('PRESENCE_TICKET_SECRET='));
  const value = (line ?? '').slice('PRESENCE_TICKET_SECRET='.length).trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error(`PRESENCE_TICKET_SECRET is missing or empty in ${path}`);
  return value;
}
const secret = readTicketSecret(values['dev-vars']);

const round = (v: number): number => Math.round(v * 10) / 10;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const incrementMap = <K>(m: Map<K, number>, key: K): void => {
  m.set(key, (m.get(key) ?? 0) + 1);
};
const pickCategory = (): (typeof ACTIVITY_CATEGORIES)[number] =>
  ACTIVITY_CATEGORIES[Math.floor(Math.random() * ACTIVITY_CATEGORIES.length)] ?? 'other';

interface LatencyStats { n: number; p50: number | null; p95: number | null; p99: number | null; max: number | null }
function latencyStats(values: number[]): LatencyStats {
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number): number | null => (s.length === 0 ? null : round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0));
  return { n: s.length, p50: at(50), p95: at(95), p99: at(99), max: at(100) };
}

/** Client IP for the n-th virtual browser: distinct per socket, so the per-IP cap never trips in the ramp. */
const poolIp = (n: number): string => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;

// ---- virtual browsers -------------------------------------------------------------------------

interface SnapshotRecord { at: number; active: number; categoriesSum: number }

interface VirtualClient {
  key: string;
  ip: string;
  subscriber: boolean;
  ws: WebSocket | null;
  opened: boolean;
  closedByUs: boolean;
  closeCode: number | null;
  /** performance.now() just after the heartbeat that makes this session count was sent. */
  hbSentAt: number;
  snapshots: SnapshotRecord[];
  timer: ReturnType<typeof setTimeout> | null;
}

const newClient = (key: string, ip: string, subscriber: boolean): VirtualClient => ({
  key, ip, subscriber, ws: null, opened: false, closedByUs: false, closeCode: null, hbSentAt: 0, snapshots: [], timer: null,
});

/** Run-wide tallies of server errors and server-initiated closes, reported as code counts. */
const tallies = { serverErrors: new Map<string, number>(), unexpectedCloses: new Map<number, number>() };

type ParsedMessage = { t: 'snapshot'; active: number; categoriesSum: number } | { t: 'error'; code: string };

function parseServerMessage(raw: unknown): ParsedMessage | null {
  if (typeof raw !== 'string') return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || !('t' in v)) return null;
  if (v.t === 'error' && 'code' in v && typeof v.code === 'string') return { t: 'error', code: v.code };
  if (v.t !== 'snapshot' || !('data' in v) || typeof v.data !== 'object' || v.data === null) return null;
  const data = v.data;
  if (!('active' in data) || typeof data.active !== 'number') return null;
  const categories: unknown[] = 'categories' in data && Array.isArray(data.categories) ? data.categories : [];
  const categoriesSum = categories.reduce<number>((sum, c) => sum + (typeof c === 'object' && c !== null && 'count' in c && typeof c.count === 'number' ? c.count : 0), 0);
  return { t: 'snapshot', active: data.active, categoriesSum };
}

function startHeartbeats(client: VirtualClient): void {
  const loop = (): void => {
    if (client.ws?.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify({ t: 'hb', cat: pickCategory() }));
    client.timer = setTimeout(loop, config.heartbeatMs);
  };
  client.timer = setTimeout(loop, Math.random() * config.heartbeatMs);
}

function stopHeartbeats(client: VirtualClient): void {
  if (client.timer !== null) clearTimeout(client.timer);
  client.timer = null;
}

interface ConnectOutcome { ok: boolean; openMs: number | null; error: string | null }

/** Opens one socket with a freshly signed ticket; resolves on open (or on the first failure). */
async function connect(client: VirtualClient, subscribe: boolean): Promise<ConnectOutcome> {
  const ticket = await signPresenceTicket(secret, {
    k: client.key, c: true, m: false, o: false, exp: Date.now() + TICKET_TTL_MS, n: crypto.randomUUID(),
  });
  const started = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: ConnectOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(outcome);
    };
    const ws = new WebSocket(`${config.wsBase}/v1/connect`, {
      protocols: [PRESENCE_SUBPROTOCOL, ticket],
      headers: { Origin: config.origin, 'CF-Connecting-IP': client.ip },
    });
    const guard = setTimeout(() => {
      finish({ ok: false, openMs: null, error: 'connect timeout' });
      ws.close();
    }, CONNECT_TIMEOUT_MS);
    client.ws = ws;
    ws.onopen = () => {
      client.opened = true;
      const openMs = performance.now() - started;
      client.hbSentAt = performance.now();
      ws.send(JSON.stringify({ t: 'hb', cat: pickCategory() }));
      if (subscribe) ws.send(JSON.stringify({ t: 'sub' }));
      startHeartbeats(client);
      finish({ ok: true, openMs, error: null });
    };
    ws.onmessage = (e) => onServerMessage(client, e.data);
    ws.onerror = (e) => finish({ ok: false, openMs: null, error: 'message' in e && typeof e.message === 'string' ? e.message : 'websocket error' });
    ws.onclose = (e) => {
      stopHeartbeats(client);
      client.closeCode = e.code;
      if (!client.opened) finish({ ok: false, openMs: null, error: `closed before open (${e.code})` });
      else if (!client.closedByUs) incrementMap(tallies.unexpectedCloses, e.code);
    };
  });
}

function onServerMessage(client: VirtualClient, raw: unknown): void {
  const msg = parseServerMessage(raw);
  if (!msg) return;
  if (msg.t === 'error') incrementMap(tallies.serverErrors, msg.code);
  else if (client.subscriber) client.snapshots.push({ at: performance.now(), active: msg.active, categoriesSum: msg.categoriesSum });
}

function closeClient(client: VirtualClient): void {
  client.closedByUs = true;
  stopHeartbeats(client);
  if (client.ws?.readyState === WebSocket.OPEN) client.ws.close(1000, 'load-test');
}

/**
 * Waits until every subscriber has received a snapshot showing `expected` active sessions, taken after
 * `sinceMs`. Returns one latency per subscriber (ms from `sinceMs`) plus the number that timed out.
 */
async function waitForActive(subs: VirtualClient[], expected: number, sinceMs: number, timeoutMs: number): Promise<{ latencies: number[]; timeouts: number }> {
  const deadline = performance.now() + timeoutMs;
  const done = new Map<VirtualClient, number>();
  while (performance.now() < deadline && done.size < subs.length) {
    for (const s of subs) {
      if (done.has(s)) continue;
      const hit = s.snapshots.find((snap) => snap.at >= sinceMs && snap.active === expected);
      if (hit) done.set(s, hit.at - sinceMs);
    }
    if (done.size < subs.length) await sleep(25);
  }
  return { latencies: [...done.values()], timeouts: subs.length - done.size };
}

// ---- server reads -----------------------------------------------------------------------------

async function readSnapshot(): Promise<PresenceSnapshot> {
  const res = await fetch(`${config.base}/v1/snapshot`);
  if (!res.ok) throw new Error(`GET /v1/snapshot returned ${res.status}`);
  const body: PresenceSnapshot = await res.json();
  return body;
}

/**
 * Polls GET /v1/snapshot until `active` equals `expected`. The REST read is cached by design (2 s isolate
 * memo, 5 s edge cache), so it can trail the WebSocket push; the elapsed time is reported, not hidden.
 */
async function restConverge(expected: number, sinceMs: number, timeoutMs: number): Promise<{ matched: boolean; ms: number; active: number }> {
  const deadline = performance.now() + timeoutMs;
  let snap = await readSnapshot();
  while (snap.active !== expected && performance.now() < deadline) {
    await sleep(250);
    snap = await readSnapshot();
  }
  return { matched: snap.active === expected, ms: round(performance.now() - sinceMs), active: snap.active };
}

async function readDiagnostics(): Promise<PresenceDiagnostics> {
  const res = await fetch(`${config.base}/internal/diagnostics`, {
    headers: { [PRESENCE_INTERNAL_HEADER]: await signPresenceInternal(secret) },
  });
  if (!res.ok) throw new Error(`GET /internal/diagnostics returned ${res.status}`);
  const body: PresenceDiagnostics = await res.json();
  return body;
}

interface HttpResult {
  snapshot: LatencyStats;
  history: LatencyStats;
  statuses: Record<string, number>;
}

/** Fires `config.httpRequests` GETs with `config.httpConcurrency` in flight, alternating the two public reads. */
async function httpLoad(): Promise<HttpResult> {
  const paths = ['/v1/snapshot', '/v1/history'] as const;
  const samples: Record<(typeof paths)[number], number[]> = { '/v1/snapshot': [], '/v1/history': [] };
  const statuses = new Map<string, number>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < config.httpRequests) {
      const path = paths[next++ % 2] ?? '/v1/snapshot';
      const t0 = performance.now();
      try {
        const res = await fetch(config.base + path);
        await res.arrayBuffer();
        if (res.ok) samples[path].push(performance.now() - t0);
        incrementMap(statuses, `${path} ${res.status}`);
      } catch {
        incrementMap(statuses, `${path} network-error`);
      }
    }
  };
  await Promise.all(Array.from({ length: config.httpConcurrency }, worker));
  return {
    snapshot: latencyStats(samples['/v1/snapshot']),
    history: latencyStats(samples['/v1/history']),
    statuses: Object.fromEntries(statuses),
  };
}

// ---- resource sampling ------------------------------------------------------------------------

/** `ps` TIME column: `m:ss.xx` or `h:mm:ss.xx`, returned as seconds. */
const parseCpuTime = (time: string): number => time.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);

function sampleTree(rootPid: number): { rssKb: number; cpuSec: number; processes: number } {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,time='], { encoding: 'utf8' });
  const rows = new Map<number, { rss: number; cpu: number }>();
  const children = new Map<number, number[]>();
  for (const line of out.trim().split('\n')) {
    const [pid = '', ppid = '', rss = '0', time = '0:00'] = line.trim().split(/\s+/);
    rows.set(Number(pid), { rss: Number(rss), cpu: parseCpuTime(time) });
    children.set(Number(ppid), [...(children.get(Number(ppid)) ?? []), Number(pid)]);
  }
  let rssKb = 0;
  let cpuSec = 0;
  let processes = 0;
  const stack = [rootPid];
  for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
    const row = rows.get(p);
    if (!row) continue;
    rssKb += row.rss;
    cpuSec += row.cpu;
    processes += 1;
    stack.push(...(children.get(p) ?? []));
  }
  return { rssKb, cpuSec, processes };
}

interface ResourceSample { atMs: number; rssKb: number; cpuSec: number; processes: number }

/** Samples the Worker process tree for the whole run; a no-op when --worker-pid is not given. */
function startSampler(pid: number | null): { stop: () => void; samples: ResourceSample[] } {
  const samples: ResourceSample[] = [];
  if (pid === null) return { stop: () => undefined, samples };
  const take = (): void => {
    try {
      samples.push({ atMs: performance.now(), ...sampleTree(pid) });
    } catch {
      // The process exited or ps failed; the next tick tries again.
    }
  };
  take();
  const timer = setInterval(take, SAMPLE_INTERVAL_MS);
  return {
    stop: () => {
      clearInterval(timer);
      take();
    },
    samples,
  };
}

// ---- phases -----------------------------------------------------------------------------------

interface CapResult { attempted: number; accepted: number; rejectedOverCapacity: number; otherFailures: number }

/** Opens `count` sockets that all share one IP or one key and reports how many the Worker admitted. */
async function capProbe(count: number, ipFor: (i: number) => string, keyFor: (i: number) => string): Promise<CapResult> {
  const clients = Array.from({ length: count }, (_, i) => newClient(keyFor(i), ipFor(i), false));
  const outcomes = await Promise.all(clients.map((c) => connect(c, false)));
  await sleep(1_500);
  const accepted = clients.filter((c) => c.ws?.readyState === WebSocket.OPEN);
  const rejectedOverCapacity = clients.filter((c) => c.closeCode === 1013).length;
  for (const c of accepted) closeClient(c);
  await sleep(2_000);
  return {
    attempted: count,
    accepted: accepted.length,
    rejectedOverCapacity,
    otherFailures: outcomes.filter((o) => !o.ok).length,
  };
}

async function main(): Promise<void> {
  const runId = crypto.randomUUID().slice(0, 8);
  const runStart = performance.now();
  const sampler = startSampler(config.workerPid);

  const health = await fetch(`${config.base}/v1/health`);
  if (!health.ok) throw new Error(`GET /v1/health returned ${health.status}; is the Worker running at ${config.base}?`);
  const diagnosticsBefore = await readDiagnostics();

  const capResults = config.capCheck
    ? {
        perIp: await capProbe(21, () => '192.0.2.10', (i) => `cap-ip-${runId}-${i}`),
        perKey: await capProbe(11, (i) => `192.0.2.${20 + i}`, () => `cap-key-${runId}`),
      }
    : null;
  tallies.unexpectedCloses.clear();

  // Ramp: `rate / 10` connects every 100 ms.
  const pool = Array.from({ length: config.connections }, (_, i) =>
    newClient(`vb-${runId}-${i}`, poolIp(i + 1), i < config.subscribers),
  );
  const subs = pool.slice(0, config.subscribers);
  const batch = Math.max(1, Math.round(config.rampPerSecond / 10));
  const rampStart = performance.now();
  const pending: Promise<ConnectOutcome>[] = [];
  for (let i = 0; i < pool.length; i += batch) {
    for (const c of pool.slice(i, i + batch)) pending.push(connect(c, c.subscriber));
    await sleep(100);
  }
  const launchMs = performance.now() - rampStart;
  const outcomes = await Promise.all(pending);
  const rampEnd = performance.now();
  const opened = outcomes.filter((o) => o.ok);
  const connectFailures = new Map<string, number>();
  for (const o of outcomes) if (!o.ok) incrementMap(connectFailures, o.error ?? 'unknown');
  let expected = opened.length;

  await sleep(3_000);
  const afterRamp = await waitForActive(subs, expected, rampEnd, CONVERGE_TIMEOUT_MS);
  const restAfterRamp = await restConverge(expected, rampEnd, CONVERGE_TIMEOUT_MS);

  // Hold: heartbeats run throughout; probes and HTTP reads share the window.
  const holdMs = config.holdSeconds * 1000;
  const holdStart = performance.now();
  const probeGap = config.probes > 0 ? Math.floor(holdMs / config.probes) : holdMs;
  const probeClients: VirtualClient[] = [];
  const probeResults: { kind: 'open' | 'close'; expected: number; latencies: number[]; timeouts: number }[] = [];
  let probeIp = config.connections;
  const runProbes = async (): Promise<void> => {
    for (let p = 0; p < config.probes; p++) {
      await sleep(probeGap);
      if (p % 2 === 0) {
        const c = newClient(`vb-${runId}-probe-${p}`, poolIp(++probeIp), false);
        const outcome = await connect(c, false);
        if (!outcome.ok) continue;
        expected += 1;
        const r = await waitForActive(subs, expected, c.hbSentAt, PROBE_TIMEOUT_MS);
        probeResults.push({ kind: 'open', expected, ...r });
        probeClients.push(c);
      } else {
        const c = probeClients.pop();
        if (!c) continue;
        const since = performance.now();
        closeClient(c);
        expected -= 1;
        const r = await waitForActive(subs, expected, since, PROBE_TIMEOUT_MS);
        probeResults.push({ kind: 'close', expected, ...r });
      }
    }
  };
  const httpPromise = (async (): Promise<HttpResult | null> => {
    await sleep(Math.min(20_000, Math.floor(holdMs / 4)));
    return config.httpRequests > 0 ? httpLoad() : null;
  })();
  await Promise.all([runProbes(), httpPromise]);
  const http = await httpPromise;
  await sleep(Math.max(0, holdMs - (performance.now() - holdStart)));
  const holdExpected = expected;
  const restAtHoldEnd = await restConverge(holdExpected, performance.now(), CONVERGE_TIMEOUT_MS);
  const holdDiagnostics = await readDiagnostics();
  const holdUnexpectedCloses = Object.fromEntries(tallies.unexpectedCloses);
  const holdServerErrors = Object.fromEntries(tallies.serverErrors);

  // Churn: close a block of pool sockets in one burst and time the drop at subscribers.
  const churnTargets = pool.slice(config.subscribers, config.subscribers + config.churn);
  const churnSince = performance.now();
  for (const c of churnTargets) closeClient(c);
  expected -= churnTargets.length;
  const churnConverge = config.churn > 0 ? await waitForActive(subs, expected, churnSince, CONVERGE_TIMEOUT_MS) : null;
  const restAfterChurn = await restConverge(expected, churnSince, CONVERGE_TIMEOUT_MS);

  // Teardown: close everything still open and check the count returns to zero.
  const remaining = [...pool, ...probeClients].filter((c) => !c.closedByUs);
  for (const c of remaining) closeClient(c);
  let finalActive = -1;
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(250);
    finalActive = (await readSnapshot()).active;
    if (finalActive === 0) break;
  }
  const finalDiagnostics = await readDiagnostics();
  sampler.stop();

  const samples = sampler.samples;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const wallSec = first && last ? (last.atMs - first.atMs) / 1000 : 0;
  const cpuDeltaSec = first && last ? last.cpuSec - first.cpuSec : 0;

  const summary = {
    at: new Date().toISOString(),
    config: { ...config, runId },
    diagnosticsBefore,
    capProbes: capResults,
    ramp: {
      attempted: pool.length,
      opened: opened.length,
      failed: pool.length - opened.length,
      failureReasons: Object.fromEntries(connectFailures),
      launchMs: round(launchMs),
      achievedPerSecond: round(pool.length / (launchMs / 1000)),
      rampWallMs: round(rampEnd - rampStart),
      connectLatencyMs: latencyStats(opened.map((o) => o.openMs ?? 0)),
      activeAfterRamp: { expected: opened.length, rest: restAfterRamp, subscriberConverge: afterRamp },
    },
    hold: {
      seconds: config.holdSeconds,
      probes: probeResults.map((p) => ({ kind: p.kind, expected: p.expected, subscriberLatencyMs: latencyStats(p.latencies), timeouts: p.timeouts })),
      probeLatencyMs: latencyStats(probeResults.flatMap((p) => p.latencies)),
      probeTimeouts: probeResults.reduce((n, p) => n + p.timeouts, 0),
      http,
      activeAtEnd: { expected: holdExpected, rest: restAtHoldEnd },
      unexpectedCloses: holdUnexpectedCloses,
      serverErrors: holdServerErrors,
      diagnostics: holdDiagnostics,
    },
    churn: {
      closed: churnTargets.length,
      expectedAfter: expected,
      subscriberLatencyMs: churnConverge ? latencyStats(churnConverge.latencies) : null,
      timeouts: churnConverge?.timeouts ?? 0,
      restAfter: restAfterChurn,
    },
    teardown: { closed: remaining.length, activeAfterTeardown: finalActive, diagnostics: finalDiagnostics },
    resources: {
      pid: config.workerPid,
      samples: samples.length,
      peakRssMb: samples.length ? round(Math.max(...samples.map((s) => s.rssKb)) / 1024) : null,
      maxProcesses: samples.length ? Math.max(...samples.map((s) => s.processes)) : null,
      cpuSeconds: round(cpuDeltaSec),
      avgCpuPercent: wallSec > 0 ? round((cpuDeltaSec / wallSec) * 100) : null,
    },
    durationSec: round((performance.now() - runStart) / 1000),
  };

  const text = JSON.stringify(summary, null, 2);
  console.log(text);
  if (values.out) writeFileSync(values.out, `${text}\n`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'unknown error');
  process.exit(1);
});
