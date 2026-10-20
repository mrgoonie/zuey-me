/** Anonymous MCP lane: `bun run agent-eval:mcp [--base URL] [--json out.json]`. Read-only tools only. */
import { formatTable, parseArgs, writeJson } from './lib/cli';
import { checkExpectation } from './lib/expect';
import { MCP_TASKS, READ_ONLY_TOOLS } from './tasks-mcp';
import type { McpTask, TaskResult } from './lib/types';

const { base, json } = parseArgs(process.argv.slice(2));
let nextId = 1;

async function rpc(method: string, params?: unknown): Promise<string> {
  const res = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return body;
}

/** Flattens a tools/call result to the text an agent would read. */
function resultText(raw: string): string {
  const parsed: unknown = JSON.parse(raw);
  const msg = parsed as { error?: { message?: string }; result?: { isError?: boolean; content?: { text?: string }[] } };
  if (msg.error) throw new Error(msg.error.message ?? 'rpc error');
  if (msg.result?.isError) throw new Error(msg.result.content?.[0]?.text ?? 'tool error');
  return msg.result?.content?.map((c) => c.text ?? '').join('\n') ?? raw;
}

async function runTask(task: McpTask): Promise<TaskResult> {
  if (!READ_ONLY_TOOLS.has(task.tool)) throw new Error(`refusing non read-only tool ${task.tool}`);
  try {
    const raw = task.tool === 'tools/list' ? await rpc('tools/list') : await rpc('tools/call', { name: task.tool, arguments: task.args ?? {} });
    const text = task.tool === 'tools/list' ? raw : resultText(raw);
    const { passed, reason } = checkExpectation(task.expect, { text, hrefs: [] });
    return { id: task.id, lane: 'mcp', passed, reason };
  } catch (e) {
    return { id: task.id, lane: 'mcp', passed: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

const results: TaskResult[] = [];
for (const task of MCP_TASKS) results.push(await runTask(task));
console.log(formatTable('mcp', base, results));
writeJson(json, 'mcp', base, results);
