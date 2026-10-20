import type { AssertionSigner, LifecycleEvent, LifecycleResult } from '@dewee/identity';
import { DeweeIdentityError, MIN_SECRET_LENGTH, exchangeSession, lifecycle } from '@dewee/identity';
import type { RuntimeEnv } from '../../env';
import { DEFAULT_AGENT_KEY } from '../ai/dewee-client';
import { AppError } from '../http';
import { membersRuntime } from '../members/runtime';

/**
 * Dewee Connect (hosted account linking). Dewee links chat accounts to zuey.me members and keeps the links;
 * zuey.me only proves who its member is, with assertions signed by the identity application secret:
 * - the `/dewee/connect` handoff (see `src/pages/dewee/connect.ts`);
 * - lifecycle events, so Dewee revokes or re-scopes a member's access on every replica at once;
 * - a short server-side session to list or unlink the member's own linked chat accounts.
 * The member id (`users.id`) is the Dewee `external_subject`. No gateway operator credential is used here.
 */

export const DEWEE_IDENTITY_ENV_NAMES = ['DEWEE_GATEWAY_URL', 'DEWEE_APPLICATION_ID', 'DEWEE_IDENTITY_ISSUER', 'DEWEE_ASSERTION_SECRET'] as const;

/** Shortest identity session Dewee issues; it is only used for one bindings call. */
const BINDINGS_SESSION_TTL_SECONDS = 60;
/** Lifecycle calls run after billing or deletion has committed: keep them short. */
const LIFECYCLE_TIMEOUT_MS = 3000;
const BINDINGS_TIMEOUT_MS = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DeweeIdentityConfig {
  gatewayUrl: string;
  /** Origin of the hosted Connect pages: DEWEE_CONNECT_BASE_URL, else the gateway URL. */
  connectBaseUrl: string;
  /** Agent the bindings session is bound to (DEWEE_AGENT_KEY). */
  agent: string;
  signer: AssertionSigner;
}

function trimmed(v: string | undefined): string {
  return (v ?? '').trim();
}

/** Names of the identity variables that are missing or unusable (a short secret counts as missing). */
export function missingDeweeIdentityEnv(env: RuntimeEnv): string[] {
  const missing: string[] = [];
  if (!trimmed(env.DEWEE_GATEWAY_URL)) missing.push('DEWEE_GATEWAY_URL');
  if (!UUID_RE.test(trimmed(env.DEWEE_APPLICATION_ID))) missing.push('DEWEE_APPLICATION_ID');
  if (!trimmed(env.DEWEE_IDENTITY_ISSUER)) missing.push('DEWEE_IDENTITY_ISSUER');
  if (trimmed(env.DEWEE_ASSERTION_SECRET).length < MIN_SECRET_LENGTH) missing.push('DEWEE_ASSERTION_SECRET');
  return missing;
}

export function deweeIdentityConfig(env: RuntimeEnv): DeweeIdentityConfig | null {
  if (missingDeweeIdentityEnv(env).length > 0) return null;
  const gatewayUrl = trimmed(env.DEWEE_GATEWAY_URL);
  return {
    gatewayUrl,
    connectBaseUrl: trimmed(env.DEWEE_CONNECT_BASE_URL) || gatewayUrl,
    agent: trimmed(env.DEWEE_AGENT_KEY) || DEFAULT_AGENT_KEY,
    signer: {
      applicationId: trimmed(env.DEWEE_APPLICATION_ID),
      issuer: trimmed(env.DEWEE_IDENTITY_ISSUER),
      secret: trimmed(env.DEWEE_ASSERTION_SECRET),
    },
  };
}

/** Throws 503 `dewee_identity_unconfigured` naming the missing variables (never their values). */
export function requireDeweeIdentityConfig(env: RuntimeEnv): DeweeIdentityConfig {
  const missing = missingDeweeIdentityEnv(env);
  const cfg = missing.length === 0 ? deweeIdentityConfig(env) : null;
  if (!cfg) throw new AppError(503, 'dewee_identity_unconfigured', 'Dewee account linking is not configured', { missing });
  return cfg;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/**
 * The SDK's outbound HTTP goes through the injectable members runtime, so tests can observe it. The SDK types
 * its option as the global `fetch`, which under Bun's types also carries `preconnect`; the SDK never calls it.
 */
const sdkFetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => membersRuntime.fetch(requestUrl(input), init),
  { preconnect: () => undefined },
);

/** Safe log text for a failed identity call: the code and status only, never a token, secret or subject. */
function describeError(err: unknown): string {
  if (err instanceof DeweeIdentityError) return `${err.code} (${err.status})`;
  return err instanceof Error ? err.name : 'unknown';
}

export type LifecycleOutcome =
  | { status: 'applied'; result: LifecycleResult }
  /** The member never linked a chat account, so Dewee has no principal for them: nothing to do. */
  | { status: 'not_linked' }
  | { status: 'unconfigured' }
  | { status: 'failed'; error: string };

/**
 * Reports a member lifecycle event to Dewee. Never throws: the billing or account operation that triggered
 * it has already committed, and Dewee's own checks stay the source of truth if a call is lost.
 */
export async function reportMemberLifecycle(
  env: RuntimeEnv, userId: string, event: LifecycleEvent, scopes?: string[],
): Promise<LifecycleOutcome> {
  const cfg = deweeIdentityConfig(env);
  if (!cfg) return { status: 'unconfigured' };
  try {
    const result = await lifecycle({
      gatewayUrl: cfg.gatewayUrl, signer: cfg.signer, subject: userId, event, scopes,
      fetch: sdkFetch, timeoutMs: LIFECYCLE_TIMEOUT_MS,
    });
    return { status: 'applied', result };
  } catch (err) {
    if (err instanceof DeweeIdentityError && err.code === 'NOT_FOUND') return { status: 'not_linked' };
    const error = describeError(err);
    console.warn(`dewee identity lifecycle ${event} failed:`, error);
    return { status: 'failed', error };
  }
}

/** A chat account linked to the member in Dewee. The full sender id stays in Dewee; only its hint is shown. */
export interface MemberChannelBinding {
  id: string;
  channel_type: string;
  sender_hint: string;
  linked_at: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  return typeof v === 'string' ? v : '';
}

/** Maps a Dewee failure to the zuey.me error envelope without echoing anything Dewee sent. */
function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof DeweeIdentityError) {
    if (err.code === 'NOT_FOUND') return new AppError(404, 'not_found', 'Linked chat account not found');
    if (err.code === 'LINK_REVOKED') return new AppError(409, 'dewee_identity_revoked', 'Chat account linking is not available for this account');
    console.warn('dewee identity call failed:', describeError(err));
  } else {
    console.warn('dewee identity call failed:', describeError(err));
  }
  return new AppError(502, 'dewee_identity_unavailable', 'Dewee could not be reached; try again shortly');
}

async function bindingsRequest(cfg: DeweeIdentityConfig, userId: string, method: 'GET' | 'DELETE', path: string): Promise<unknown> {
  const session = await exchangeSession({
    gatewayUrl: cfg.gatewayUrl, signer: cfg.signer, subject: userId, agent: cfg.agent,
    ttlSeconds: BINDINGS_SESSION_TTL_SECONDS, fetch: sdkFetch, timeoutMs: BINDINGS_TIMEOUT_MS,
  });
  const res = await membersRuntime.fetch(`${cfg.gatewayUrl.replace(/\/+$/, '')}${path}`, {
    method,
    headers: { Accept: 'application/json', [session.header]: session.sessionToken },
    redirect: 'error',
    signal: AbortSignal.timeout(BINDINGS_TIMEOUT_MS),
  });
  if (res.status === 404) throw new AppError(404, 'not_found', 'Linked chat account not found');
  if (!res.ok) {
    console.warn(`dewee identity ${method} ${path.split('/').slice(0, 5).join('/')} answered`, res.status);
    throw new AppError(502, 'dewee_identity_unavailable', 'Dewee could not be reached; try again shortly');
  }
  return res.json().catch(() => null);
}

/** The member's linked chat accounts, read from Dewee with a one-minute session of that member. */
export async function listMemberBindings(env: RuntimeEnv, userId: string): Promise<MemberChannelBinding[]> {
  const cfg = requireDeweeIdentityConfig(env);
  let body: unknown;
  try {
    body = await bindingsRequest(cfg, userId, 'GET', '/v1/identity/me/bindings');
  } catch (err) {
    throw toAppError(err);
  }
  const list = isRecord(body) && Array.isArray(body.bindings) ? body.bindings : [];
  return list
    .filter(isRecord)
    .filter(b => text(b, 'status') === 'linked' && UUID_RE.test(text(b, 'id')))
    .map(b => ({ id: text(b, 'id'), channel_type: text(b, 'channel_type'), sender_hint: text(b, 'sender_hint'), linked_at: text(b, 'linked_at') || null }));
}

/** Validates a binding id from a path; throws AppError 400. */
export function parseBindingId(raw: unknown): string {
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
    throw new AppError(400, 'invalid_field', 'binding id must be a UUID', { field: 'binding_id' });
  }
  return raw.toLowerCase();
}

/** Unlinks one of the member's own chat accounts in Dewee. Another member's binding is a 404 there. */
export async function unlinkMemberBinding(env: RuntimeEnv, userId: string, bindingId: string): Promise<void> {
  const cfg = requireDeweeIdentityConfig(env);
  try {
    await bindingsRequest(cfg, userId, 'DELETE', `/v1/identity/me/bindings/${encodeURIComponent(bindingId)}`);
  } catch (err) {
    throw toAppError(err);
  }
}
