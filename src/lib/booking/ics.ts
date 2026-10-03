/** Minimal RFC 5545 calendar invite builder for consultation bookings. */

export interface IcsEvent {
  uid: string;
  start: string; // UTC ISO
  end: string; // UTC ISO
  summary: string;
  description: string;
  location?: string | null;
  organizerEmail: string;
  organizerName?: string;
  attendeeEmail: string;
  attendeeName?: string;
  sequence?: number;
  stamp?: string; // UTC ISO, defaults to now
}

function toIcsDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid ICS date: ${iso}`);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function escapeIcsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
}

function escapeParam(value: string): string {
  return value.replace(/["\r\n]/g, '');
}

/** Folds a content line at 75 octets (UTF-8 aware) with CRLF + space continuations. */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const len = encoder.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74;
    if (size + len > limit) {
      out.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += len;
  }
  out.push(current);
  return out.join('\r\n ');
}

export function buildIcs(ev: IcsEvent): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//zuey.me//Business Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${ev.uid}`,
    `DTSTAMP:${toIcsDate(ev.stamp ?? new Date().toISOString())}`,
    `DTSTART:${toIcsDate(ev.start)}`,
    `DTEND:${toIcsDate(ev.end)}`,
    `SEQUENCE:${ev.sequence ?? 0}`,
    `SUMMARY:${escapeIcsText(ev.summary)}`,
    `DESCRIPTION:${escapeIcsText(ev.description)}`,
    ...(ev.location ? [`LOCATION:${escapeIcsText(ev.location)}`, `URL:${ev.location}`] : []),
    `ORGANIZER;CN="${escapeParam(ev.organizerName ?? 'Zuey')}":mailto:${ev.organizerEmail}`,
    `ATTENDEE;CN="${escapeParam(ev.attendeeName ?? ev.attendeeEmail)}";ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${ev.attendeeEmail}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** Base64 of a UTF-8 string using Web APIs only. */
export function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
