/**
 * Runtime validation of the presence Worker's admin diagnostics (`GET /internal/diagnostics`), shared by the
 * Pages server client and the Studio panel. Client-safe (no server imports). The parser re-builds the
 * object from the contract's fields only, so an unexpected extra field (a key, IP or ticket a future Worker
 * bug might add) is never passed on to admins or logs.
 */
import { PRESENCE_CONTRACT_VERSION, type PresenceDiagnostics } from './contract';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const isTimeOrNull = (v: unknown): v is string | null => v === null || isTime(v);

/** A valid PresenceDiagnostics with only the contract's fields, or null for any other shape. */
export function parsePresenceDiagnostics(v: unknown): PresenceDiagnostics | null {
  if (!isRecord(v) || v.v !== PRESENCE_CONTRACT_VERSION || !isTime(v.at)) return null;
  const { sockets: s, limits: l, counters: c, alarm: a, history: h } = v;
  if (!isRecord(s) || !isRecord(l) || !isRecord(c) || !isRecord(a) || !isRecord(h)) return null;

  if (
    !isCount(s.total) || !isCount(s.activeSessions) || !isCount(s.idle) || !isCount(s.watchOnly) ||
    !isCount(s.subscribers) || !isCount(s.owner)
  ) return null;
  if (!isCount(l.maxTotal) || !isCount(l.maxPerIp) || !isCount(l.maxPerKey)) return null;
  if (
    !isTime(c.startedAt) || !isCount(c.connectsAccepted) || !isCount(c.connectsRejected) ||
    !isCount(c.messagesDropped) || !isCount(c.abuseCloses) || !isCount(c.broadcasts)
  ) return null;
  if (!isTimeOrNull(a.nextAt) || !isTimeOrNull(a.lastRunAt) || !(a.lastRunMs === null || (typeof a.lastRunMs === 'number' && Number.isFinite(a.lastRunMs) && a.lastRunMs >= 0))) {
    return null;
  }
  if (!isCount(h.buckets) || !isTimeOrNull(h.oldest) || !isCount(h.storageBytes)) return null;

  return {
    v: PRESENCE_CONTRACT_VERSION,
    at: v.at,
    sockets: {
      total: s.total, activeSessions: s.activeSessions, idle: s.idle, watchOnly: s.watchOnly, subscribers: s.subscribers, owner: s.owner,
    },
    limits: { maxTotal: l.maxTotal, maxPerIp: l.maxPerIp, maxPerKey: l.maxPerKey },
    counters: {
      startedAt: c.startedAt,
      connectsAccepted: c.connectsAccepted,
      connectsRejected: c.connectsRejected,
      messagesDropped: c.messagesDropped,
      abuseCloses: c.abuseCloses,
      broadcasts: c.broadcasts,
    },
    alarm: { nextAt: a.nextAt, lastRunAt: a.lastRunAt, lastRunMs: a.lastRunMs },
    history: { buckets: h.buckets, oldest: h.oldest, storageBytes: h.storageBytes },
  };
}

export const isPresenceDiagnostics = (v: unknown): v is PresenceDiagnostics => parsePresenceDiagnostics(v) !== null;
