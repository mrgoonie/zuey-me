import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import type { Row } from './runtime';
import { DAY_MS, iso, membersRuntime, randomId, randomSecret, sha256Hex, str, strOrNull } from './runtime';

/** Scopes a member can grant a personal key. There is deliberately no admin scope. */
export const USER_KEY_SCOPES = ['articles:read', 'chat:write', 'account:read', 'account:write', 'billing:read', 'checkout:write'] as const;
export type UserKeyScope = (typeof USER_KEY_SCOPES)[number];

export const USER_KEY_PREFIX = 'zk_';
export const MAX_ACTIVE_KEYS = 20;
export const MAX_KEY_DAYS = 365;
const LAST_USED_INTERVAL_MS = 5 * 60 * 1000;

export interface UserApiKey {
  id: string;
  user_id: string;
  prefix: string;
  name: string;
  scopes: UserKeyScope[];
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  replaced_by: string | null;
}

export type UserApiKeyStatus = 'active' | 'expired' | 'revoked';
export type UserApiKeyView = Omit<UserApiKey, 'user_id'> & { status: UserApiKeyStatus };

export function isUserKeyScope(v: unknown): v is UserKeyScope {
  return typeof v === 'string' && (USER_KEY_SCOPES as readonly string[]).includes(v);
}

function parseScopes(text: string): UserKeyScope[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter(isUserKeyScope) : [];
  } catch {
    return [];
  }
}

function rowToKey(row: Row): UserApiKey {
  return {
    id: str(row, 'id'),
    user_id: str(row, 'user_id'),
    prefix: str(row, 'prefix'),
    name: str(row, 'name'),
    scopes: parseScopes(str(row, 'scopes')),
    created_at: str(row, 'created_at'),
    expires_at: str(row, 'expires_at'),
    last_used_at: strOrNull(row, 'last_used_at'),
    revoked_at: strOrNull(row, 'revoked_at'),
    replaced_by: strOrNull(row, 'replaced_by'),
  };
}

export function keyStatus(key: UserApiKey, now: number): UserApiKeyStatus {
  if (key.revoked_at) return 'revoked';
  return Date.parse(key.expires_at) <= now ? 'expired' : 'active';
}

export function toKeyView(key: UserApiKey, now: number): UserApiKeyView {
  const { user_id: _owner, ...rest } = key;
  return { ...rest, status: keyStatus(key, now) };
}

export interface KeyInput {
  name: string;
  scopes: UserKeyScope[];
  expires_in_days: number;
}

/** Validates create/rotate bodies. Unknown scopes (including anything admin-like) are rejected. */
export function parseKeyInput(body: Record<string, unknown>, defaults?: { name: string; scopes: UserKeyScope[] }): KeyInput {
  const bad = (field: string, msg: string): never => {
    throw new AppError(400, 'invalid_field', `${field} ${msg}`, { field });
  };
  const rawName = body.name ?? defaults?.name;
  if (typeof rawName !== 'string' || rawName.trim().length === 0 || rawName.trim().length > 60) bad('name', 'must be 1–60 characters');
  const rawScopes = body.scopes ?? defaults?.scopes;
  if (!Array.isArray(rawScopes) || rawScopes.length === 0) bad('scopes', `must be a non-empty array of ${USER_KEY_SCOPES.join(', ')}`);
  const scopes: UserKeyScope[] = [];
  for (const s of Array.isArray(rawScopes) ? rawScopes : []) {
    if (!isUserKeyScope(s)) bad('scopes', `contains an unknown scope; allowed: ${USER_KEY_SCOPES.join(', ')}`);
    else if (!scopes.includes(s)) scopes.push(s);
  }
  if (defaults) {
    const widened = scopes.filter(s => !defaults.scopes.includes(s));
    if (widened.length > 0) bad('scopes', `may not add scopes on rotate (${widened.join(', ')}); create a new key instead`);
  }
  const days = body.expires_in_days ?? 90;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_KEY_DAYS) {
    bad('expires_in_days', `must be an integer between 1 and ${MAX_KEY_DAYS}`);
  }
  return { name: typeof rawName === 'string' ? rawName.trim() : '', scopes, expires_in_days: typeof days === 'number' ? days : 90 };
}

async function insertKey(d1: D1DatabaseLike, userId: string, input: KeyInput): Promise<{ secret: string; key: UserApiKey }> {
  const secret = USER_KEY_PREFIX + randomSecret(32);
  const now = membersRuntime.now();
  const key: UserApiKey = {
    id: randomId('uk'),
    user_id: userId,
    prefix: secret.slice(0, 10),
    name: input.name,
    scopes: input.scopes,
    created_at: iso(now),
    expires_at: iso(now + input.expires_in_days * DAY_MS),
    last_used_at: null,
    revoked_at: null,
    replaced_by: null,
  };
  await d1.prepare(
    'INSERT INTO user_api_keys (id, user_id, prefix, key_hash, name, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(key.id, userId, key.prefix, await sha256Hex(secret), key.name, JSON.stringify(key.scopes), key.created_at, key.expires_at).run();
  return { secret, key };
}

async function countActiveKeys(d1: D1DatabaseLike, userId: string): Promise<number> {
  const row = await d1.prepare('SELECT COUNT(*) AS n FROM user_api_keys WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?')
    .bind(userId, iso(membersRuntime.now())).first<Row>();
  return Number(row?.n ?? 0);
}

export async function createUserKey(d1: D1DatabaseLike, userId: string, input: KeyInput): Promise<{ secret: string; key: UserApiKey }> {
  if ((await countActiveKeys(d1, userId)) >= MAX_ACTIVE_KEYS) {
    throw new AppError(409, 'key_limit_reached', `At most ${MAX_ACTIVE_KEYS} active keys per account; revoke one first`);
  }
  return insertKey(d1, userId, input);
}

export async function listUserKeys(d1: D1DatabaseLike, userId: string): Promise<UserApiKey[]> {
  const { results } = await d1.prepare('SELECT * FROM user_api_keys WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all<Row>();
  return (results ?? []).map(rowToKey);
}

/** Own key or 404, so another member's key id is indistinguishable from a missing one. */
export async function getOwnKey(d1: D1DatabaseLike, userId: string, keyId: string): Promise<UserApiKey> {
  const row = await d1.prepare('SELECT * FROM user_api_keys WHERE id = ? AND user_id = ?').bind(keyId, userId).first<Row>();
  if (!row) throw new AppError(404, 'not_found', 'API key not found');
  return rowToKey(row);
}

/**
 * Issues a replacement with the same (or narrower) scopes. The old key keeps working until the
 * member explicitly revokes it, so tools can be switched over without downtime.
 */
export async function rotateUserKey(d1: D1DatabaseLike, userId: string, keyId: string, body: Record<string, unknown>): Promise<{ secret: string; key: UserApiKey; previous: UserApiKey }> {
  const old = await getOwnKey(d1, userId, keyId);
  if (keyStatus(old, membersRuntime.now()) !== 'active') throw new AppError(409, 'key_inactive', 'Only active keys can be rotated');
  if (old.replaced_by) throw new AppError(409, 'already_rotated', 'This key already has a replacement; revoke it or rotate the replacement');
  const input = parseKeyInput(body, { name: old.name, scopes: old.scopes });
  const created = await insertKey(d1, userId, input);
  const res = await d1.prepare('UPDATE user_api_keys SET replaced_by = ? WHERE id = ? AND user_id = ? AND replaced_by IS NULL')
    .bind(created.key.id, old.id, userId).run();
  if (!res.meta?.changes) {
    await d1.prepare('DELETE FROM user_api_keys WHERE id = ?').bind(created.key.id).run();
    throw new AppError(409, 'already_rotated', 'This key was rotated concurrently');
  }
  return { ...created, previous: { ...old, replaced_by: created.key.id } };
}

export async function revokeUserKey(d1: D1DatabaseLike, userId: string, keyId: string): Promise<UserApiKey> {
  const key = await getOwnKey(d1, userId, keyId);
  if (key.revoked_at) return key;
  const now = iso(membersRuntime.now());
  await d1.prepare('UPDATE user_api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').bind(now, keyId, userId).run();
  return { ...key, revoked_at: now };
}

export type KeyVerification =
  | { ok: true; key: UserApiKey }
  | { ok: false; reason: 'invalid' | 'expired' | 'revoked' };

/** Verifies a raw `zk_` secret by hash; expired and revoked keys are rejected explicitly. */
export async function verifyUserKey(d1: D1DatabaseLike, secret: string): Promise<KeyVerification> {
  if (!secret.startsWith(USER_KEY_PREFIX) || secret.length > 200) return { ok: false, reason: 'invalid' };
  const row = await d1.prepare(
    `SELECT k.* FROM user_api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = ? AND u.deleted_at IS NULL`
  ).bind(await sha256Hex(secret)).first<Row>();
  if (!row) return { ok: false, reason: 'invalid' };
  const key = rowToKey(row);
  const now = membersRuntime.now();
  const status = keyStatus(key, now);
  if (status !== 'active') return { ok: false, reason: status };
  if (!key.last_used_at || now - Date.parse(key.last_used_at) > LAST_USED_INTERVAL_MS) {
    await d1.prepare('UPDATE user_api_keys SET last_used_at = ? WHERE id = ?').bind(iso(now), key.id).run()
      .catch((err: unknown) => console.error('user key last_used update failed:', err instanceof Error ? err.message : 'unknown'));
  }
  return { ok: true, key };
}
