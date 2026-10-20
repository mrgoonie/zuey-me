/** No-JS fetch lane: `bun run agent-eval:fetch [--base URL] [--json out.json]`. */
import { cachedFetcher, crawl, type PageFetcher } from './lib/crawl';
import { formatTable, hasErrors, parseArgs, writeJson } from './lib/cli';
import { checkExpectation, escapeRegex, evidenceFromPages, normalizeSpace } from './lib/expect';
import { mcpRequest } from './lib/mcp-client';
import { isRecord, parseToolText, RunnerError } from './lib/rpc';
import { FETCH_TASKS } from './tasks-fetch';
import type { FetchTask, TaskResult } from './lib/types';

const { base, json } = parseArgs(process.argv.slice(2));

const rawFetch: PageFetcher = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'zueyos-agent-eval/1 (no-js)', accept: 'text/html,text/markdown,text/plain' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  const contentType = res.headers.get('content-type') ?? '';
  const body = /html|text|markdown|json|xml/i.test(contentType) ? await res.text() : '';
  return { status: res.status, contentType, body };
};
const fetchPage = cachedFetcher(rawFetch);

/** Ground truth for "latest article" comes from the anonymous MCP API, never hard-coded. */
async function latestArticleTitle(): Promise<string> {
  const rpc = await mcpRequest(base, 'tools/call', { name: 'article_list', arguments: { limit: 1 } });
  const out = parseToolText(rpc);
  if (!out.ok) throw new RunnerError(`latest article lookup: ${out.error}`);
  const list: unknown = JSON.parse(out.text);
  const first: unknown = Array.isArray(list) ? list[0] : undefined;
  if (!isRecord(first) || typeof first.title !== 'string' || !first.title) throw new RunnerError('latest article lookup: no title in article_list');
  return first.title;
}

async function runTask(task: FetchTask): Promise<TaskResult> {
  try {
    const { pages, errors } = await crawl(base, fetchPage, { entries: task.entries, follow: task.follow, maxHops: task.maxHops });
    const matchers = [...task.expect.matchers];
    if (task.truth === 'latest-article-title') {
      matchers.push({ text: escapeRegex(normalizeSpace(await latestArticleTitle())).replaceAll(' ', '\\s+') });
    }
    const { passed, reason } = checkExpectation({ matchers, min: task.expect.min }, evidenceFromPages(pages, base));
    if (passed) return { id: task.id, lane: 'fetch', passed, reason: `ok (${pages.length} pages fetched)` };
    if (errors.length) return { id: task.id, lane: 'fetch', passed: false, error: true, reason: `transport: ${errors[0]}` };
    return { id: task.id, lane: 'fetch', passed, reason: `${reason} (${pages.length} pages fetched)` };
  } catch (e) {
    return { id: task.id, lane: 'fetch', passed: false, error: true, reason: e instanceof Error ? e.message : String(e) };
  }
}

try {
  const home = await rawFetch(new URL('/', base).href).catch((e: unknown) => {
    throw new RunnerError(`preflight ${base}/: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (home.status !== 200) throw new RunnerError(`preflight ${base}/: HTTP ${home.status}`);
  const results: TaskResult[] = [];
  for (const task of FETCH_TASKS) results.push(await runTask(task));
  console.log(formatTable('fetch', base, results));
  writeJson(json, 'fetch', base, results);
  if (hasErrors(results)) process.exitCode = 1;
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
