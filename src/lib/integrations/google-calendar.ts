import type { RuntimeEnv } from '../../env';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type IntegrationStatus = 'sent' | 'unconfigured' | 'failed';

export interface CalendarEventInput {
  requestId: string;
  summary: string;
  description: string;
  start: string;
  end: string;
  attendeeEmail: string;
  attendeeName?: string;
}

export interface CalendarResult {
  status: IntegrationStatus;
  eventId?: string;
  meetUrl?: string;
  error?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Lists the env variables the Google Calendar integration still needs. */
export function missingCalendarConfig(env: RuntimeEnv): string[] {
  const missing: string[] = [];
  if (!env.GOOGLE_CLIENT_ID) missing.push('GOOGLE_CLIENT_ID');
  if (!env.GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET');
  if (!env.GOOGLE_CALENDAR_REFRESH_TOKEN) missing.push('GOOGLE_CALENDAR_REFRESH_TOKEN');
  return missing;
}

async function getAccessToken(env: RuntimeEnv, fetchImpl: FetchLike): Promise<string> {
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.GOOGLE_CLIENT_ID ?? '',
      client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
      refresh_token: env.GOOGLE_CALENDAR_REFRESH_TOKEN ?? '',
    }).toString(),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || !isRecord(body) || typeof body.access_token !== 'string') {
    throw new Error(`google_token_${res.status}`);
  }
  return body.access_token;
}

function extractMeetUrl(body: Record<string, unknown>): string | undefined {
  if (typeof body.hangoutLink === 'string') return body.hangoutLink;
  const conf = body.conferenceData;
  if (isRecord(conf) && Array.isArray(conf.entryPoints)) {
    for (const ep of conf.entryPoints) {
      if (isRecord(ep) && ep.entryPointType === 'video' && typeof ep.uri === 'string') return ep.uri;
    }
  }
  return undefined;
}

function calendarBase(env: RuntimeEnv): string {
  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID || 'primary')}/events`;
}

/** Creates a calendar event with a Google Meet conference; never throws. */
export async function createMeetEvent(env: RuntimeEnv, input: CalendarEventInput, fetchImpl: FetchLike): Promise<CalendarResult> {
  if (missingCalendarConfig(env).length > 0) return { status: 'unconfigured', error: 'google_calendar_unconfigured' };
  try {
    const token = await getAccessToken(env, fetchImpl);
    const res = await fetchImpl(`${calendarBase(env)}?conferenceDataVersion=1&sendUpdates=all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: input.summary,
        description: input.description,
        start: { dateTime: input.start, timeZone: 'UTC' },
        end: { dateTime: input.end, timeZone: 'UTC' },
        attendees: [{ email: input.attendeeEmail, displayName: input.attendeeName }],
        conferenceData: { createRequest: { requestId: input.requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      }),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok || !isRecord(body) || typeof body.id !== 'string') {
      return { status: 'failed', error: `google_calendar_${res.status}` };
    }
    return { status: 'sent', eventId: body.id, meetUrl: extractMeetUrl(body) };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message.slice(0, 120) : 'google_calendar_error' };
  }
}

/** Moves an existing event to a new time; never throws. */
export async function rescheduleMeetEvent(
  env: RuntimeEnv, eventId: string, start: string, end: string, fetchImpl: FetchLike
): Promise<CalendarResult> {
  if (missingCalendarConfig(env).length > 0) return { status: 'unconfigured', error: 'google_calendar_unconfigured' };
  try {
    const token = await getAccessToken(env, fetchImpl);
    const res = await fetchImpl(`${calendarBase(env)}/${encodeURIComponent(eventId)}?sendUpdates=all`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: { dateTime: start, timeZone: 'UTC' }, end: { dateTime: end, timeZone: 'UTC' } }),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok || !isRecord(body)) return { status: 'failed', error: `google_calendar_${res.status}` };
    return { status: 'sent', eventId, meetUrl: extractMeetUrl(body) };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message.slice(0, 120) : 'google_calendar_error' };
  }
}
