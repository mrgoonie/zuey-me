/**
 * Admin diagnostics for the PresenceHub (served through the Worker's `/internal/diagnostics`). Counts and
 * timings only: the payload is assembled field by field from numbers, so no key, IP hash, ticket or owner
 * text can reach it.
 */
import { PRESENCE_CONTRACT_VERSION, type PresenceDiagnostics } from '../../../src/lib/presence/contract';
import type { HistoryStats } from './presence-history';
import { MAX_SOCKETS_PER_IP, MAX_SOCKETS_PER_KEY, MAX_SOCKETS_TOTAL, isLive, type SocketSession } from './presence-state';

/** In-memory hub counters since the object last woke (they reset whenever it hibernates or is evicted). */
export interface HubCounters {
  startedAt: number;
  connectsAccepted: number;
  connectsRejected: number;
  messagesDropped: number;
  abuseCloses: number;
  broadcasts: number;
}

export const newHubCounters = (now: number): HubCounters => ({
  startedAt: now, connectsAccepted: 0, connectsRejected: 0, messagesDropped: 0, abuseCloses: 0, broadcasts: 0,
});

export interface AlarmTimes {
  nextAt: number | null;
  lastRunAt: number | null;
  lastRunMs: number | null;
}

/**
 * Socket breakdown. `owner`: owner-ticket sockets; `watchOnly`: other sockets without counting consent;
 * `idle`: other consented sockets that are not live (hidden, idle or no heartbeat yet). `subscribers`
 * overlaps the others (any socket can subscribe).
 */
function socketBreakdown(sessions: readonly SocketSession[], now: number) {
  let idle = 0;
  let watchOnly = 0;
  let subscribers = 0;
  let owner = 0;
  for (const s of sessions) {
    if (s.sub) subscribers += 1;
    if (s.o) owner += 1;
    else if (!s.c) watchOnly += 1;
    else if (!isLive(s, now)) idle += 1;
  }
  return { idle, watchOnly, subscribers, owner };
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export function buildDiagnostics(input: {
  now: number;
  totalSockets: number;
  sessions: readonly SocketSession[];
  activeSessions: number;
  counters: HubCounters;
  alarm: AlarmTimes;
  history: HistoryStats;
}): PresenceDiagnostics {
  const { now, counters, alarm, history } = input;
  return {
    v: PRESENCE_CONTRACT_VERSION,
    at: new Date(now).toISOString(),
    sockets: { total: input.totalSockets, activeSessions: input.activeSessions, ...socketBreakdown(input.sessions, now) },
    limits: { maxTotal: MAX_SOCKETS_TOTAL, maxPerIp: MAX_SOCKETS_PER_IP, maxPerKey: MAX_SOCKETS_PER_KEY },
    counters: {
      startedAt: new Date(counters.startedAt).toISOString(),
      connectsAccepted: counters.connectsAccepted,
      connectsRejected: counters.connectsRejected,
      messagesDropped: counters.messagesDropped,
      abuseCloses: counters.abuseCloses,
      broadcasts: counters.broadcasts,
    },
    alarm: { nextAt: iso(alarm.nextAt), lastRunAt: iso(alarm.lastRunAt), lastRunMs: alarm.lastRunMs },
    history: { buckets: history.buckets, oldest: history.oldest, storageBytes: history.storageBytes },
  };
}
