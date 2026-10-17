/** REST side of idempotency keys: routes pass the request, actor and the write to run. */
import type { D1DatabaseLike } from '../../db/store';
import { jsonOk } from '../http';
import { requireDb } from '../taxonomy/common';
import { idempotencyKeyFrom, markReplay, withIdempotency, withoutIdempotencyKey } from './store';

export const IDEMPOTENT_REPLAY_HEADER = 'Idempotent-Replayed';

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : { value };
}

/**
 * Runs an admin write once per `Idempotency-Key` header (or `idempotency_key` body field). Without a key it
 * behaves like a plain write. A replay returns the stored body with `idempotent_replay: true` and the
 * `Idempotent-Replayed: true` header. Call after the admin gate; `params` and `body` fingerprint the request.
 */
export async function idempotentJson(
  opts: {
    request: Request; d1: D1DatabaseLike | undefined; actor: string; operation: string;
    params?: Record<string, unknown>; body?: Record<string, unknown>; status?: number; headers?: Record<string, string>;
  },
  run: () => Promise<unknown>,
): Promise<Response> {
  const status = opts.status ?? 200;
  const body = opts.body ?? {};
  const key = idempotencyKeyFrom(opts.request, body);
  if (key === undefined || key === null || key === '') return jsonOk(await run(), status, opts.headers);
  const { result, replayed } = await withIdempotency(
    { d1: requireDb(opts.d1), actor: opts.actor, operation: opts.operation, key, request: { params: opts.params ?? {}, body: withoutIdempotencyKey(body) } },
    async () => asObject(await run()),
  );
  return jsonOk(markReplay(result, replayed), status, { ...opts.headers, ...(replayed ? { [IDEMPOTENT_REPLAY_HEADER]: 'true' } : {}) });
}
