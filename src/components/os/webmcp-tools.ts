/**
 * WebMCP tools for Zuey OS (W3C Web Machine Learning CG draft): read and navigate only, no mutations.
 * Registered on `document.modelContext` (current draft) or the deprecated `navigator.modelContext`
 * when either exists; a browser without WebMCP gets a silent no-op. Loaded lazily after idle by
 * ZueyOSStaticIndex.astro, so it never touches LCP or TBT.
 *
 * Every `execute` resolves and never throws: results are plain objects/arrays (the draft serializes them
 * to JSON itself) and failures are `error: …` strings. A rejected promise would reach the agent as an
 * opaque OperationError, while an error string lets it self-correct.
 */
import { LOCALES, isLocale, type Locale } from '../../lib/i18n/locales';
import { APP_IDS, OPEN_APP_EVENT, isAppId, type AppId, type OpenAppEventDetail } from './apps';
import { absoluteUrl, appDirectory } from './app-directory';

/** Tool names and one-line purposes, also listed in llms.txt and index.md. */
export const WEBMCP_TOOL_SUMMARIES = [
  { name: 'zueyos_list_apps', summary: 'List every Zuey OS app with its id, name, summary, standalone route and #app deep link.' },
  { name: 'zueyos_open_app', summary: 'Open an app window on the Zuey OS desktop by id (same as the #<id> deep link).' },
  { name: 'zueyos_search_articles', summary: 'Search Duy’s articles (GET /api/v1/search); returns titles, URLs, Markdown URLs and snippets.' },
  { name: 'zueyos_get_profile', summary: 'Get Duy Nguyen’s public profile: name, handle, intro, avatar and contact links.' },
] as const;

export type WebMcpToolName = (typeof WEBMCP_TOOL_SUMMARIES)[number]['name'];

interface ToolAnnotations { readOnlyHint?: boolean; untrustedContentHint?: boolean; consequentialHint?: boolean }

export interface WebMcpTool {
  name: WebMcpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: unknown) => Promise<unknown>;
  annotations: ToolAnnotations;
}

/** The subset of the draft `ModelContext` interface used here (registerTool, or legacy provideContext). */
interface ModelContextLike {
  registerTool?: (tool: WebMcpTool, options?: { signal?: AbortSignal }) => unknown;
  provideContext?: (context: { tools: WebMcpTool[] }) => unknown;
}

export interface WebMcpDeps {
  locale: Locale;
  /** Defaults to `globalThis.fetch`; called with same-origin paths only. */
  fetchImpl?: (path: string, init?: RequestInit) => Promise<Response>;
  /** Defaults to `openAppFromAgent`. */
  openApp?: (id: AppId) => void;
}

const MAX_RESULT_CHARS = 1500;
const SUMMARY_BY_NAME = new Map<string, string>(WEBMCP_TOOL_SUMMARIES.map(t => [t.name, t.summary]));
const summaryOf = (name: WebMcpToolName): string => SUMMARY_BY_NAME.get(name) ?? name;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : 'unknown error');

/** `{ success, data }` envelope from src/lib/http.ts → data, or an error string. */
async function readEnvelope(res: Response): Promise<{ data: unknown } | { error: string }> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { error: `HTTP ${res.status}: response was not JSON` };
  }
  if (isRecord(body) && body.success === true && 'data' in body) return { data: body.data };
  const err = isRecord(body) && isRecord(body.error) ? body.error : null;
  const message = err && typeof err.message === 'string' ? err.message : `HTTP ${res.status}`;
  return { error: message };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Asks ZueyOS to open a window on behalf of an agent, so analytics tag it `source: 'webmcp'`. ZueyOS
 * cancels the event to acknowledge it; if the island has not hydrated, the `#id` hash opens it later.
 */
export function openAppFromAgent(id: AppId): void {
  const detail: OpenAppEventDetail = { id, source: 'webmcp' };
  const handled = !window.dispatchEvent(new CustomEvent(OPEN_APP_EVENT, { detail, cancelable: true }));
  if (!handled) window.location.hash = `#${id}`;
}

export function createZueyOsTools(deps: WebMcpDeps): WebMcpTool[] {
  const doFetch = deps.fetchImpl ?? ((path: string, init?: RequestInit) => globalThis.fetch(path, init));
  const openApp = deps.openApp ?? openAppFromAgent;

  return [
    {
      name: 'zueyos_list_apps',
      description: `${summaryOf('zueyos_list_apps')} Use zueyos_open_app to open one here, or navigate to its route.`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => appDirectory(deps.locale).map(app => ({
        id: app.id, name: app.name, summary: app.summary, route: absoluteUrl(app.route), deep_link: absoluteUrl(app.deepLink),
      })),
    },
    {
      name: 'zueyos_open_app',
      description: `${summaryOf('zueyos_open_app')} Get valid ids from zueyos_list_apps.`,
      inputSchema: {
        type: 'object',
        properties: { app_id: { type: 'string', enum: [...APP_IDS], description: 'App id, e.g. "pricing" or "knowledges".' } },
        required: ['app_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: async input => {
        const id = isRecord(input) ? input.app_id : undefined;
        if (!isAppId(id)) return `error: unknown app_id ${JSON.stringify(id ?? null)}; valid ids: ${APP_IDS.join(', ')}`;
        openApp(id);
        const app = appDirectory(deps.locale).find(a => a.id === id);
        return { opened: id, name: app?.name ?? id, deep_link: absoluteUrl(`/#${id}`), route: absoluteUrl(app?.route ?? `/#${id}`) };
      },
    },
    {
      name: 'zueyos_search_articles',
      description: `${summaryOf('zueyos_search_articles')} Paid articles return previews unless the visitor is a member.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 200, description: 'Search words in any language.' },
          limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Max results (default 5).' },
          locale: { type: 'string', enum: [...LOCALES], description: 'Article language (default: the page language).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      // Snippets quote article text: data for the agent, never instructions.
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async input => {
        const query = isRecord(input) && typeof input.query === 'string' ? input.query.trim() : '';
        if (!query || query.length > 200) return 'error: query must be 1–200 characters';
        const rawLimit = isRecord(input) ? input.limit : undefined;
        const limit = rawLimit === undefined ? 5 : rawLimit;
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10) return 'error: limit must be an integer 1–10';
        const rawLocale = isRecord(input) ? input.locale : undefined;
        const locale = rawLocale === undefined ? deps.locale : rawLocale;
        if (!isLocale(locale)) return `error: locale must be one of ${LOCALES.join(', ')}`;
        try {
          const params = new URLSearchParams({ q: query, limit: String(limit), locale });
          const res = await doFetch(`/api/v1/search?${params}`, { headers: { Accept: 'application/json' } });
          const out = await readEnvelope(res);
          if ('error' in out) return `error: ${out.error}`;
          const results = isRecord(out.data) && Array.isArray(out.data.results) ? out.data.results : [];
          const hits = results.filter(isRecord).map(h => ({
            title: str(h.title), url: str(h.url), markdown_url: str(h.markdown_url), access: str(h.access), snippet: str(h.snippet).slice(0, 240),
          }));
          // Drop trailing hits until the serialized result fits the tool output budget.
          while (JSON.stringify(hits).length > MAX_RESULT_CHARS && hits.length > 1) hits.pop();
          return { query, locale, results: hits, browse: absoluteUrl('/articles') };
        } catch (err) {
          return `error: search failed (${errorMessage(err)})`;
        }
      },
    },
    {
      name: 'zueyos_get_profile',
      description: summaryOf('zueyos_get_profile'),
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => {
        try {
          const out = await readEnvelope(await doFetch('/api/v1/profile', { headers: { Accept: 'application/json' } }));
          if ('error' in out) return `error: ${out.error}`;
          const p = isRecord(out.data) ? out.data : {};
          return {
            name: str(p.name), handle: str(p.handle), intro: str(deps.locale === 'vi' ? p.intro_vi : p.intro_en) || str(p.intro_en),
            avatar_url: str(p.avatar_url), email: str(p.email), website: absoluteUrl('/'), markdown: absoluteUrl('/index.md'), links: absoluteUrl('/links.md'),
          };
        } catch (err) {
          return `error: profile unavailable (${errorMessage(err)})`;
        }
      },
    },
  ];
}

function isModelContext(v: unknown): v is ModelContextLike {
  if (typeof v !== 'object' || v === null) return false;
  const register = 'registerTool' in v ? v.registerTool : undefined;
  const provide = 'provideContext' in v ? v.provideContext : undefined;
  return typeof register === 'function' || typeof provide === 'function';
}

/** `document.modelContext` (current draft) first, then the deprecated `navigator.modelContext`. */
export function findModelContext(doc: object | undefined, nav: object | undefined): ModelContextLike | null {
  for (const host of [doc, nav]) {
    if (host && 'modelContext' in host && isModelContext(host.modelContext)) return host.modelContext;
  }
  return null;
}

/** Swallow both sync throws and async rejections (duplicate name, missing origin isolation…). */
function settle(fn: () => unknown): void {
  try {
    const result: unknown = fn();
    if (typeof result === 'object' && result !== null && 'then' in result && typeof result.then === 'function') {
      result.then(undefined, () => {});
    }
  } catch {
    /* registration refused: the page keeps working without the tool */
  }
}

/**
 * Registers the tools and returns an unregister function, or null when WebMCP is unavailable.
 * `registerTool` takes an AbortSignal (the draft's only unregister path); the older
 * `provideContext` API replaces the whole tool set and is cleared with an empty one.
 */
export function registerZueyOsTools(
  deps: WebMcpDeps,
  hosts: { doc?: object; nav?: object } = {
    doc: typeof document === 'undefined' ? undefined : document,
    nav: typeof navigator === 'undefined' ? undefined : navigator,
  },
): (() => void) | null {
  const ctx = findModelContext(hosts.doc, hosts.nav);
  if (!ctx) return null;
  const tools = createZueyOsTools(deps);
  const { registerTool, provideContext } = ctx;
  if (typeof registerTool === 'function') {
    const controller = new AbortController();
    for (const tool of tools) settle(() => registerTool.call(ctx, tool, { signal: controller.signal }));
    return () => controller.abort();
  }
  if (typeof provideContext === 'function') {
    settle(() => provideContext.call(ctx, { tools }));
    return () => settle(() => provideContext.call(ctx, { tools: [] }));
  }
  return null;
}

/** Page entry: reads the locale from the server-rendered index and registers once per page. */
let registered = false;
export function startZueyOsWebMcp(localeHint: string | undefined): void {
  if (registered) return;
  const locale: Locale = isLocale(localeHint) ? localeHint : 'en';
  registered = registerZueyOsTools({ locale }) !== null;
}
