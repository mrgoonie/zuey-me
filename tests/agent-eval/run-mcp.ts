/** Anonymous MCP lane: `bun run agent-eval:mcp [--base URL] [--json out.json]`. Read-only tools only. */
import { formatTable, hasErrors, parseArgs, writeJson } from './lib/cli';
import { checkExpectation } from './lib/expect';
import { mcpRequest } from './lib/mcp-client';
import { findUnexpectedTools, isRecord, parseToolNames, parseToolText, RunnerError } from './lib/rpc';
import { MCP_TASKS, READ_ONLY_TOOLS } from './tasks-mcp';
import type { McpTask, TaskResult } from './lib/types';

const { base, json } = parseArgs(process.argv.slice(2));

async function runTask(task: McpTask): Promise<TaskResult> {
  const done = (passed: boolean, reason: string): TaskResult => ({ id: task.id, lane: 'mcp', passed, reason });
  try {
    if (task.tool === 'tools/list') {
      const rpc = await mcpRequest(base, 'tools/list');
      const names = parseToolNames(rpc);
      if (!names) throw new RunnerError('tools/list: unexpected response shape');
      if (task.check === 'read-only-surface') {
        const bad = findUnexpectedTools(names, READ_ONLY_TOOLS);
        return bad.length ? done(false, `non read-only tool(s) exposed anonymously: ${bad.join(', ')}`) : done(true, `ok (${names.length} tools, all read-only)`);
      }
      const r = checkExpectation(task.expect, { text: names.map((n) => `"${n}"`).join(' '), hrefs: [], base });
      return done(r.passed, r.reason);
    }
    if (!READ_ONLY_TOOLS.has(task.tool)) throw new RunnerError(`refusing non read-only tool ${task.tool}`);
    const out = parseToolText(await mcpRequest(base, 'tools/call', { name: task.tool, arguments: task.args ?? {} }));
    if (!out.ok) return { ...done(false, out.error), error: true };
    const r = checkExpectation(task.expect, { text: out.text, hrefs: [], base });
    return done(r.passed, r.reason);
  } catch (e) {
    if (e instanceof RunnerError && /refusing/.test(e.message)) throw e;
    return { ...done(false, e instanceof Error ? e.message : String(e)), error: true };
  }
}

try {
  const init = await mcpRequest(base, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'zueyos-agent-eval', version: '1' } });
  if (!isRecord(init) || !isRecord(init.result)) throw new RunnerError('preflight initialize: no result');
  const results: TaskResult[] = [];
  for (const task of MCP_TASKS) results.push(await runTask(task));
  console.log(formatTable('mcp', base, results));
  writeJson(json, 'mcp', base, results);
  if (hasErrors(results)) process.exitCode = 1;
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
