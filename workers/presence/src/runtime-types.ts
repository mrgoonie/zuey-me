/**
 * Minimal structural types for the Workers runtime APIs the presence Worker uses (Durable Objects,
 * WebSocket hibernation). Declared locally, like the rest of the repo's `*Like` bindings, so the root
 * `astro check` and the Worker share one set of types without pulling in @cloudflare/workers-types.
 */

/** Server side of a WebSocket accepted through the hibernation API. */
export interface HubWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** A WebSocket from `new WebSocketPair()`; `accept()` is only used to reject a connection politely. */
export interface PairWebSocket extends HubWebSocket {
  accept(): void;
}

export interface DurableObjectStorageLike {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
  acceptWebSocket(ws: HubWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): HubWebSocket[];
}

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectIdLike {
  toString(): string;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface PresenceEnv {
  PRESENCE_HUB: DurableObjectNamespaceLike;
  /** Shared with the Pages app, which signs connect tickets with it. Set once with `wrangler secret put`. */
  PRESENCE_TICKET_SECRET?: string;
}
