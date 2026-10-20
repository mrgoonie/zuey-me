/**
 * Presence data contract shared by the zuey.me Pages app, the browser presence client, the
 * Activity Monitor app and the `zuey-me-presence` Worker (workers/presence). Per-visitor presence is
 * ephemeral (socket attachments in the Worker's Durable Object); only aggregate state and owner status
 * reach that Durable Object's own storage. Never D1 or PostHog.
 *
 * Self-contained on purpose (no app imports) so the Worker bundle can import it directly.
 */

export const PRESENCE_CONTRACT_VERSION = 1;

/** Public origin of the presence Worker (custom domain). Overridable with `PUBLIC_PRESENCE_URL` in dev. */
export const PRESENCE_DEFAULT_ORIGIN = 'https://presence.zuey.me';

/** Client heartbeat while the tab is visible; a session expires when no heartbeat arrives within the TTL. */
export const PRESENCE_HEARTBEAT_MS = 25_000;
export const PRESENCE_TTL_MS = 75_000;

/**
 * WebSocket subprotocol of the presence Worker. Clients offer `[PRESENCE_SUBPROTOCOL, ticket]` so the
 * ticket travels in the `Sec-WebSocket-Protocol` header (never in the URL, which logs record); the Worker
 * answers with this value alone.
 */
export const PRESENCE_SUBPROTOCOL = 'zuey-presence.v1';

/** Shape of a connect ticket: base64url payload `.` base64url signature (all valid subprotocol token chars). */
export const PRESENCE_TICKET_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Ticket lifetime: the client fetches a fresh one for each (re)connect. */
export const PRESENCE_TICKET_TTL_MS = 120_000;

/** Groups smaller than this are folded into `other` (and `members` is hidden) so no one is singled out. */
export const PRESENCE_MIN_GROUP = 3;

/** Largest client → Worker message accepted, in bytes. */
export const PRESENCE_MAX_MESSAGE_BYTES = 256;

/**
 * What a visitor is doing, derived from the route or focused ZueyOS app. A closed allowlist: the
 * Worker drops anything else, and no free text, URL, query or content ever travels with it.
 */
export const ACTIVITY_CATEGORIES = ['reading', 'zueytube', 'reads', 'ai', 'courses', 'exploring', 'other'] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export const isActivityCategory = (v: unknown): v is ActivityCategory =>
  typeof v === 'string' && (ACTIVITY_CATEGORIES as readonly string[]).includes(v);

/**
 * Public owner status. `offline` also covers `invisible`: nothing public may tell the two apart.
 * `onSite` is the separate "currently on zuey.me" signal and is false whenever the owner is invisible/offline.
 */
export type OwnerPublicStatus = 'online' | 'away' | 'busy' | 'offline';

/** Owner's manual setting. `auto` = online while the owner has a live zuey.me connection, else offline. */
export const OWNER_MODES = ['auto', 'away', 'busy', 'offline', 'invisible'] as const;
export type OwnerMode = (typeof OWNER_MODES)[number];
export const isOwnerMode = (v: unknown): v is OwnerMode => typeof v === 'string' && (OWNER_MODES as readonly string[]).includes(v);

/** Owner status text is opt-in, short and plain. */
export const OWNER_STATUS_TEXT_MAX = 80;

export interface OwnerPresence {
  status: OwnerPublicStatus;
  onSite: boolean;
  /** Present only when the owner explicitly set one and is not offline/invisible. */
  text?: string;
  /** ISO time the public status last changed. */
  since: string;
}

export interface CategoryCount {
  id: ActivityCategory;
  count: number;
}

/** The only shape the Worker publishes (GET /v1/snapshot and `snapshot` WebSocket messages). */
export interface PresenceSnapshot {
  v: typeof PRESENCE_CONTRACT_VERSION;
  /** ISO time the snapshot was computed. */
  at: string;
  /** Unique active visitor sessions (multi-tab collapsed), owner excluded. */
  active: number;
  /** Signed-in members among `active`; null when fewer than PRESENCE_MIN_GROUP. */
  members: number | null;
  /** Breakdown with groups < PRESENCE_MIN_GROUP folded into `other`; empty when `active` < PRESENCE_MIN_GROUP. */
  categories: CategoryCount[];
  owner: OwnerPresence;
}

/** One 5-minute aggregate bucket (Phase 3 history; same suppression rules as the snapshot). */
export interface PresenceHistoryBucket {
  /** ISO start of the bucket. */
  t: string;
  /** Peak unique active visitors within the bucket. */
  peak: number;
  categories: CategoryCount[];
}

export interface PresenceHistory {
  v: typeof PRESENCE_CONTRACT_VERSION;
  at: string;
  bucketMinutes: 5;
  buckets: PresenceHistoryBucket[];
}

/** Client → Worker WebSocket messages (JSON, ≤ PRESENCE_MAX_MESSAGE_BYTES). */
export type PresenceClientMessage =
  | { t: 'hb'; cat: ActivityCategory }
  | { t: 'idle' }
  | { t: 'sub' }
  | { t: 'unsub' };

/** Worker → client WebSocket messages. */
export type PresenceServerMessage =
  | { t: 'snapshot'; data: PresenceSnapshot }
  | { t: 'error'; code: 'bad_message' | 'rate_limited' | 'ticket_expired' };

/**
 * Signed connect ticket payload, issued by POST /api/v1/presence/ticket after server-side checks.
 * `k` is an opaque dedupe key (HMAC of the member id or of the browser presence id), never a raw id.
 */
export interface PresenceTicketPayload {
  /** Opaque dedupe key: all tabs of one browser (or one member across devices) share it. */
  k: string;
  /** True only when the visitor's consent allows counting; false = watch-only connection. */
  c: boolean;
  /** Signed-in member (server-checked). */
  m: boolean;
  /** Verified owner (server-checked against PRESENCE_OWNER_MEMBER_IDS, never admin role). */
  o: boolean;
  /** Expiry, epoch ms. */
  exp: number;
  /** Random nonce so two tickets never collide. */
  n: string;
}
