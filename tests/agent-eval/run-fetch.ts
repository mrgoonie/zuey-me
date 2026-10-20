/** No-JS fetch lane: `bun run agent-eval:fetch [--base URL] [--json out.json]`. */
import { crawl, type PageFetcher } from './lib/crawl';
import { formatTable, parseArgs, writeJson } from './lib/cli';
import { checkExpectation, evidenceFromPages } from './lib/expect';
import { FETCH_TASKS } from './tasks-fetch';
import type { FetchTask, TaskResult } from './lib/types';

const { base, json } = parseArgs(process.argv.slice(2));

const fetchPage: PageFetcher = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'zueyos-agent-eval/1 (no-js)', accept: 'text/html,text/markdown,text/plain' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  const contentType = res.headers.get('content-type') ?? '';
  if (!/html|text|markdown|json|xml/i.test(contentType)) return { ok: false, contentType, body: '' };
  return { ok: res.ok, contentType, body: await res.text() };
};

/** Ground truth for "latest article" comes from the anonymous MCP API, never hard-coded. */
async function latestArticleTitle(): Promise<string> {
  const res = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'article_list', arguments: { limit: 1 } } }),
    signal: AbortSignal.timeout(15000),
  });
  const rpc: unknown = await res.json();
  const text = (rpc as { result?: { content?: { text?: string }[] } }).result?.content?.[0]?.text ?? '[]';
  const list: unknown = JSON.parse(text);
  const first = Array.isArray(list) ? (list[0] as { title?: string } | undefined) : undefined;
  if (!first?.title) throw new Error('could not resolve latest article title');
  return first.title;
}

async function runTask(task: FetchTask): Promise<TaskResult> {
  const pages = await crawl(base, fetchPage, { entries: task.entries, follow: task.follow, maxHops: task.maxHops });
  const ev = evidenceFromPages(pages);
  const matchers = [...task.expect.matchers];
  if (task.truth === 'latest-article-title') {
    const title = await latestArticleTitle();
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    matchers.push({ text: escaped });
  }
  const { passed, reason } = checkExpectation({ matchers, min: task.expect.min }, ev);
  return { id: task.id, lane: 'fetch', passed, reason: passed ? `ok (${pages.length} pages fetched)` : `${reason} (${pages.length} pages fetched)` };
}

const results: TaskResult[] = [];
for (const task of FETCH_TASKS) results.push(await runTask(task));
console.log(formatTable('fetch', base, results));
writeJson(json, 'fetch', base, results);
