import { RunnerError } from './rpc';

let nextId = 1;

/** POSTs one JSON-RPC request to `${base}/api/mcp`; transport and HTTP failures throw RunnerError. */
export async function mcpRequest(base: string, method: string, params?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new RunnerError(`MCP ${method}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new RunnerError(`MCP ${method}: HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new RunnerError(`MCP ${method}: response is not JSON`);
  }
}
