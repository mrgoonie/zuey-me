/**
 * Optional idempotency keys for state-changing article and media requests. The first request with a key
 * runs and records its result; a retry (for example after a lost response) returns that stored result and
 * writes nothing, so no duplicate revisions, emails or media appear. Keys are private to the acting admin:
 * only their SHA-256 is stored and lookups are scoped to the actor.
 */
import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import { iso, membersRuntime } from '../members/runtime';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
/** How long a recorded result stays replayable. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** An unfinished claim older than this belongs to a crashed request and may be taken over. */
export const IDEMPOTENCY_STALE_MS = 2 * 60 * 1000;
/** Stored responses stay well under the D1 row limit; a larger document echo is dropped from the replay. */
const MAX_STORED_BYTES = 900_000;
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

type Json = Record<string, unknown>;

export interface IdempotencyRequest {
  d1: D1DatabaseLike;
  actor: string;
  /** Tool or route name; part of the request fingerprint. */
  operation: string;
  /** Raw key from the client, or undefined to run without idempotency. */
  key: unknown;
  /** Everything that defines the request (arguments, path parameters); the key itself is excluded. */
  request: unknown;
}

export interface IdempotentOutcome {
  result: Json;
  replayed: boolean;
}

export interface IdempotencyRecord {
  operation: string;
  state: 'in_progress' | 'done';
  status_code: number | null;
  started_at: string;
  completed_at: string | null;
  expires_at: string;
  result: Json | null;
}

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Returns the validated key, undefined when none was sent; throws 400 for a malformed key. */
export function parseIdempotencyKey(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !KEY_PATTERN.test(raw)) {
    throw new AppError(400, 'invalid_idempotency_key', 'Idempotency key must be 8-128 characters of letters, digits, . _ : -', { field: 'idempotency_key' });
  }
  return raw;
}

/** The key from the Idempotency-Key header, falling back to the body/tool argument `idempotency_key`. */
export function idempotencyKeyFrom(request: Request | undefined, args: Record<string, unknown>): unknown {
  return request?.headers.get(IDEMPOTENCY_KEY_HEADER) ?? args.idempotency_key;
}

/** Arguments without the idempotency key, so a retry fingerprints identically. */
export function withoutIdempotencyKey(args: Record<string, unknown>): Record<string, unknown> {
  const { idempotency_key: _key, ...rest } = args;
  return rest;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

function parseStored(text: unknown): Json | null {
  if (typeof text !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function serialize(result: Json): string {
  const full = JSON.stringify(result);
  if (full.length <= MAX_STORED_BYTES) return full;
  const { document: _document, ...rest } = result;
  return JSON.stringify({ ...rest, document_omitted: true });
}

interface Row {
  request_hash: string;
  state: string;
  response_json: string | null;
  started_at: string;
}

/**
 * Runs `run` at most once per (actor, key). Failures release the key so the client may retry the same
 * request; a success is stored and replayed to later requests with the same key and request.
 */
export async function withIdempotency(opts: IdempotencyRequest, run: () => Promise<Json>): Promise<IdempotentOutcome> {
  const key = parseIdempotencyKey(opts.key);
  if (key === undefined) return { result: await run(), replayed: false };

  const { d1, actor } = opts;
  const keyHash = await sha256Hex(key);
  const requestHash = await sha256Hex(canonical({ operation: opts.operation, request: opts.request }));
  const now = membersRuntime.now();
  const startedAt = iso(now);

  await d1.prepare('DELETE FROM idempotency_keys WHERE expires_at < ?').bind(startedAt).run();
  const claimed = await d1.prepare(
    `INSERT INTO idempotency_keys (actor, key_hash, operation, request_hash, state, started_at, expires_at)
     VALUES (?, ?, ?, ?, 'in_progress', ?, ?) ON CONFLICT DO NOTHING`,
  ).bind(actor, keyHash, opts.operation, requestHash, startedAt, iso(now + IDEMPOTENCY_TTL_MS)).run();

  if ((claimed.meta?.changes ?? 0) === 0) {
    const existing = await d1.prepare('SELECT request_hash, state, response_json, started_at FROM idempotency_keys WHERE actor = ? AND key_hash = ?')
      .bind(actor, keyHash).first<Row>();
    // Expired between the purge and now: let the client retry.
    if (!existing) throw new AppError(409, 'idempotency_in_progress', 'Retry the request', { retry_after_seconds: 1 });
    if (existing.request_hash !== requestHash) {
      throw new AppError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different request');
    }
    if (existing.state === 'done') {
      const stored = parseStored(existing.response_json);
      if (stored) return { result: stored, replayed: true };
      throw new AppError(409, 'idempotency_result_unavailable', 'The original request finished but its result was not stored; read the resource to confirm its state');
    }
    const age = now - Date.parse(existing.started_at);
    if (age < IDEMPOTENCY_STALE_MS) {
      throw new AppError(409, 'idempotency_in_progress', 'The original request with this key is still running; retry shortly', { retry_after_seconds: Math.max(1, Math.ceil((IDEMPOTENCY_STALE_MS - age) / 1000)) });
    }
    // The first attempt died without recording a result. Exactly one retry takes the claim over.
    const takeover = await d1.prepare(
      "UPDATE idempotency_keys SET started_at = ? WHERE actor = ? AND key_hash = ? AND state = 'in_progress' AND started_at = ?",
    ).bind(startedAt, actor, keyHash, existing.started_at).run();
    if ((takeover.meta?.changes ?? 0) === 0) {
      throw new AppError(409, 'idempotency_in_progress', 'Another retry took over this key; retry shortly', { retry_after_seconds: 1 });
    }
  }

  let result: Json;
  try {
    result = await run();
  } catch (err) {
    await d1.prepare("DELETE FROM idempotency_keys WHERE actor = ? AND key_hash = ? AND state = 'in_progress' AND request_hash = ?")
      .bind(actor, keyHash, requestHash).run().catch(() => undefined);
    throw err;
  }
  try {
    await d1.prepare("UPDATE idempotency_keys SET state = 'done', status_code = 200, response_json = ?, completed_at = ? WHERE actor = ? AND key_hash = ?")
      .bind(serialize(result), iso(membersRuntime.now()), actor, keyHash).run();
  } catch (err) {
    // The write already committed; a retry reports idempotency_in_progress instead of writing twice.
    console.error('Idempotency result was not stored:', err instanceof Error ? err.message : 'unknown');
  }
  return { result, replayed: false };
}

/** The recorded outcome for a key, scoped to the actor; null when unknown or expired. */
export async function lookupIdempotencyKey(d1: D1DatabaseLike, actor: string, rawKey: unknown): Promise<IdempotencyRecord | null> {
  const key = parseIdempotencyKey(rawKey);
  if (key === undefined) throw new AppError(400, 'invalid_idempotency_key', 'key is required', { field: 'key' });
  const row = await d1.prepare(
    'SELECT operation, state, status_code, response_json, started_at, completed_at, expires_at FROM idempotency_keys WHERE actor = ? AND key_hash = ? AND expires_at >= ?',
  ).bind(actor, await sha256Hex(key), iso(membersRuntime.now())).first<Record<string, unknown>>();
  if (!row) return null;
  return {
    operation: String(row.operation),
    state: row.state === 'done' ? 'done' : 'in_progress',
    status_code: typeof row.status_code === 'number' ? row.status_code : null,
    started_at: String(row.started_at),
    completed_at: typeof row.completed_at === 'string' ? row.completed_at : null,
    expires_at: String(row.expires_at),
    result: parseStored(row.response_json),
  };
}

/** Marks a replayed result so clients can tell it apart from a fresh write. */
export function markReplay(result: Json, replayed: boolean): Json {
  return replayed ? { ...result, idempotent_replay: true } : result;
}
