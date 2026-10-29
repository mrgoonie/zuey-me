/**
 * Client-safe owner status helpers shared by the server (REST, MCP, Worker client) and the Studio panel:
 * the text sanitizer and the runtime guard for the Worker's private owner view. No server imports.
 */
import { OWNER_STATUS_TEXT_MAX, isOwnerMode, type OwnerStatusState } from './contract';
import { isOwnerPresence } from './presence-feed-guards';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// Same cleaning as the presence Worker (workers/presence/src/owner-status.ts), so the stored text equals
// what Pages validated: line breaks and tabs become spaces; other C0/C1 controls and bidi
// embedding/override/isolate marks are dropped; then trimmed. Length is UTF-16 units (`.length`).
const LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]+/g;
const CONTROL_CHARS = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;

/** Plain single-line status text, cleaned exactly like the Worker does. */
export function sanitizeOwnerStatusText(raw: string): string {
  return raw.replace(LINE_BREAKS, ' ').replace(CONTROL_CHARS, '').trim();
}

/** Runtime check of the private owner view (Worker `/internal/owner` and the REST `data`). */
export function isOwnerStatusState(v: unknown): v is OwnerStatusState {
  return (
    isRecord(v) &&
    isOwnerMode(v.mode) &&
    (v.text === null || (typeof v.text === 'string' && v.text.length <= OWNER_STATUS_TEXT_MAX)) &&
    typeof v.updatedAt === 'string' &&
    typeof v.connected === 'boolean' &&
    isOwnerPresence(v.public)
  );
}
