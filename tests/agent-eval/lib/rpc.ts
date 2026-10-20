/** JSON-RPC / MCP response parsing with type guards (no unchecked casts) and read-only safety checks. */

export class RunnerError extends Error {}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export type ToolText = { ok: true; text: string } | { ok: false; error: string };

/** Flattens a `tools/call` JSON-RPC response to the text an agent would read. */
export function parseToolText(rpc: unknown): ToolText {
  if (!isRecord(rpc)) return { ok: false, error: 'response is not a JSON object' };
  if (isRecord(rpc.error)) {
    const m = rpc.error.message;
    return { ok: false, error: `rpc error: ${typeof m === 'string' ? m : 'unknown'}` };
  }
  if (!isRecord(rpc.result)) return { ok: false, error: 'response has no result' };
  const content = rpc.result.content;
  const text = Array.isArray(content)
    ? content.map((c) => (isRecord(c) && typeof c.text === 'string' ? c.text : '')).join('\n')
    : '';
  if (rpc.result.isError === true) return { ok: false, error: `tool error: ${text.slice(0, 120)}` };
  if (!Array.isArray(content)) return { ok: false, error: 'result has no content' };
  return { ok: true, text };
}

/** Tool names of a `tools/list` response, or null when the shape is wrong. */
export function parseToolNames(rpc: unknown): string[] | null {
  if (!isRecord(rpc) || !isRecord(rpc.result) || !Array.isArray(rpc.result.tools)) return null;
  const names: string[] = [];
  for (const t of rpc.result.tools) {
    if (!isRecord(t) || typeof t.name !== 'string') return null;
    names.push(t.name);
  }
  return names;
}

const MUTATING_SUFFIX = /_(create|update|delete|remove|set|upsert|send|sync|publish|resolve|decide|apply|cancel|run|import|upload|reorder|revert|unlink|expire|add|refetch|rewrite|reconcile|reindex|sweep|mark_paid|mark_issued|reply|post|edit|write|grant|revoke|approve|reject|refund|retry|move)$/;

/** True for names that look like a mutation under the registry's resource_verb convention. */
export const hasMutatingSuffix = (name: string) => MUTATING_SUFFIX.test(name);

/** Anonymous tools/list must only contain known read-only tools; returns the offenders. */
export function findUnexpectedTools(names: string[], readOnly: ReadonlySet<string>): string[] {
  return names.filter((n) => !readOnly.has(n) || hasMutatingSuffix(n));
}
