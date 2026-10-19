/** MCP side of idempotency keys: the shared wrapper for write tools and the admin result-lookup tool. */
import { AppError } from '../http';
import type { McpContext, McpToolModule } from '../mcp/types';
import { principalActor } from '../taxonomy/admin';
import { requireDb } from '../taxonomy/common';
import { idempotencyKeyFrom, lookupIdempotencyKey, markReplay, withIdempotency, withoutIdempotencyKey } from './store';

export const idempotencyKeyProp = {
  idempotency_key: {
    type: 'string',
    description: 'Optional opaque key (8-128 chars of letters, digits, . _ : -) that makes retries safe: repeating the same request with the same key returns the stored result (idempotent_replay: true) instead of writing again. Reusing a key for a different request fails with 422 idempotency_key_reused. Look results up with idempotency_lookup.',
  },
};

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : { value };
}

/**
 * Runs a write tool once per idempotency key. Without a key the tool runs as before. `run` receives the
 * arguments without the key; call this only after the admin gate.
 */
export async function runIdempotentTool(
  ctx: McpContext, actor: string, operation: string, args: Record<string, unknown>,
  run: (args: Record<string, unknown>) => Promise<unknown>,
): Promise<unknown> {
  const clean = withoutIdempotencyKey(args);
  const key = idempotencyKeyFrom(undefined, args);
  if (key === undefined || key === null || key === '') return run(clean);
  const { result, replayed } = await withIdempotency(
    { d1: requireDb(ctx.d1), actor, operation, key, request: clean },
    async () => asObject(await run(clean)),
  );
  return markReplay(result, replayed);
}

export const idempotencyMcpModule: McpToolModule = {
  tools: [
    {
      name: 'idempotency_lookup',
      description: 'Admin: look up what a request sent with an idempotency_key did. Returns {state: "done" | "in_progress", operation, result, ...} for 24 hours after the request, so a client that lost the response can recover it without writing again. 404 when the key is unknown or expired.',
      inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'The idempotency key that was sent' } }, required: ['key'] },
    },
  ],

  async call(name, args, ctx) {
    if (name !== 'idempotency_lookup') throw new AppError(404, 'unknown_tool', `Unknown tool ${name}`);
    await ctx.requireAdmin();
    const principal = ctx.principal ? await ctx.principal() : undefined;
    const actor = principal ? principalActor(principal) : 'mcp-admin';
    const record = await lookupIdempotencyKey(requireDb(ctx.d1), actor, args.key);
    if (!record) throw new AppError(404, 'not_found', 'No request is recorded for this key (unknown or expired)');
    return record;
  },
};
