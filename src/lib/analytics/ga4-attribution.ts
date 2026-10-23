/**
 * GA4 attribution of server-side purchases. When a member starts a checkout, the request carries the
 * first-party `_ga` (client id) and `_ga_<stream>` (session id) cookies that gtag set, but only if GA4 ran
 * with consent: gtag never loads under Do Not Track, Global Privacy Control or the site opt-out, and the
 * opt-out and every page load without consent delete those cookies. The ids are stored per member and
 * copied into the `purchase` / `refund` outbox rows, so the Measurement Protocol event joins the member's
 * web session instead of landing as an unattributed visit. Best-effort: nothing here ever throws.
 */
import type { D1DatabaseLike } from '../../db/store';
import { iso, membersRuntime } from '../members/runtime';
import { resolveGa4MeasurementId } from './destinations/ga4';
import { isGuestDistinctId } from './identity';

/** Stored ids older than this are neither used nor kept. */
export const GA4_CLIENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** A purchase joins the checkout's session only when it is paid within this window. */
export const GA4_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

const CLIENT_ID_RE = /^\d{1,20}\.\d{1,20}$/;
const SESSION_ID_RE = /^\d{1,20}$/;

export interface Ga4ClientIds {
  clientId: string;
  sessionId: string | null;
}

function cookieValue(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** `_ga=GA1.1.<random>.<timestamp>` → `<random>.<timestamp>`. */
export function parseGaClientCookie(value: string | null): string | null {
  const parts = value?.split('.') ?? [];
  if (parts.length !== 4 || !/^GA\d$/.test(parts[0] ?? '')) return null;
  const id = `${parts[2]}.${parts[3]}`;
  return CLIENT_ID_RE.test(id) ? id : null;
}

/** `_ga_<stream>`: `GS1.1.<session id>.…` or `GS2.1.s<session id>$o…`. */
export function parseGaSessionCookie(value: string | null): string | null {
  const parts = value?.split('.') ?? [];
  const field = parts[2] ?? '';
  let id: string | null = null;
  if (parts[0] === 'GS1') id = field;
  else if (parts[0] === 'GS2') id = field.split('$').find(f => f.startsWith('s'))?.slice(1) ?? null;
  return id && SESSION_ID_RE.test(id) ? id : null;
}

/** The GA ids of a browser request, or null when GA4 is off, the browser sends DNT/GPC, or no `_ga` cookie exists. */
export function ga4IdsFromRequest(request: Request, measurementIdRaw: string | undefined): Ga4ClientIds | null {
  const measurementId = resolveGa4MeasurementId(measurementIdRaw);
  if (!measurementId) return null;
  if (request.headers.get('DNT') === '1' || request.headers.get('Sec-GPC') === '1') return null;
  const cookies = request.headers.get('Cookie') ?? '';
  const clientId = parseGaClientCookie(cookieValue(cookies, '_ga'));
  if (!clientId) return null;
  return { clientId, sessionId: parseGaSessionCookie(cookieValue(cookies, `_ga_${measurementId.slice(2)}`)) };
}

/** Stores the member's GA ids at checkout start (latest wins) and drops expired rows. */
export async function rememberGa4Client(
  d1: D1DatabaseLike, measurementIdRaw: string | undefined, userId: string, request: Request,
): Promise<void> {
  try {
    const ids = ga4IdsFromRequest(request, measurementIdRaw);
    if (!ids) return;
    const nowMs = membersRuntime.now();
    await d1.prepare(
      `INSERT INTO analytics_ga4_clients (user_id, client_id, session_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET client_id = excluded.client_id, session_id = excluded.session_id, updated_at = excluded.updated_at`
    ).bind(userId, ids.clientId, ids.sessionId, iso(nowMs)).run();
    await d1.prepare('DELETE FROM analytics_ga4_clients WHERE updated_at < ?').bind(iso(nowMs - GA4_CLIENT_RETENTION_MS)).run();
  } catch (err) {
    console.debug('analytics: could not store GA4 client ids', err instanceof Error ? err.message : 'unknown');
  }
}

/**
 * Outbox properties carrying the member's stored GA ids: `ga_client_id` while the row is fresh, plus
 * `ga_session_id` when `withSession` and the checkout started within the session window. Empty otherwise.
 */
export async function ga4OutboxProperties(
  d1: D1DatabaseLike, distinctId: string, withSession: boolean,
): Promise<{ ga_client_id?: string; ga_session_id?: string }> {
  try {
    if (isGuestDistinctId(distinctId)) return {};
    const row = await d1.prepare('SELECT client_id, session_id, updated_at FROM analytics_ga4_clients WHERE user_id = ?')
      .bind(distinctId).first<{ client_id: string; session_id: string | null; updated_at: string }>();
    if (!row || !CLIENT_ID_RE.test(row.client_id)) return {};
    const age = membersRuntime.now() - Date.parse(row.updated_at);
    if (!(age >= 0 && age <= GA4_CLIENT_RETENTION_MS)) return {};
    const session = withSession && age <= GA4_SESSION_WINDOW_MS && row.session_id && SESSION_ID_RE.test(row.session_id)
      ? { ga_session_id: row.session_id } : {};
    return { ga_client_id: row.client_id, ...session };
  } catch {
    return {};
  }
}
