import { describe, it, expect, beforeEach } from 'bun:test';
import type { APIRoute } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createSession } from '../src/db/store';
import type { WorkersAiLike } from '../src/env';
import { allMcpTools } from '../src/lib/mcp/dispatch';
import { TOOL_ACCESS } from '../src/lib/oauth/tool-access';
import { OPENAPI_FRAGMENTS } from '../src/lib/openapi/registry';
import { transcriptSegments } from '../src/lib/videos/anymd-transcript-parser';
import { getEdition, getTranscriptSource } from '../src/lib/videos/store';
import { addVideo, refetchTranscript, rewriteEditionTranscript } from '../src/lib/videos/video-ingest-service';
import {
  buildSystemPrompt, chunkTranscript, formatTimestamp, parseParagraphs, placeParagraphs, rewriteTranscript, timedWords,
} from '../src/lib/videos/video-transcript-rewrite';
import {
  DEFAULT_OPENROUTER_REWRITE_MODEL, DEFAULT_WORKERS_AI_REWRITE_MODEL, workersAiRewriter,
} from '../src/lib/videos/video-transcript-rewrite-providers';
import { DEFAULT_REWRITE_GLOSSARY, mergeGlossary, parseGlossary } from '../src/lib/videos/video-transcript-glossary';
import { searchVideos } from '../src/lib/videos/video-search';
import { parseYoutubeId } from '../src/lib/videos/youtube-url';
import { POST as rewriteApi } from '../src/pages/api/v1/videos/[id]/rewrite';

const ORIGIN = 'https://zuey.test';
const VID = 'rrrrrrrrrr1';

let d1 = createTestD1();
beforeEach(() => { d1 = createTestD1(); });

const words = (n: number, prefix = 'w') => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');

// AnyMD often returns a whole video as one unpunctuated caption block.
const RAW_LINES = [`0:00 ${words(40, 'xin')} zebracornflake ${words(40, 'cho')}`];

function anymdMarkdown(id: string): string {
  return [
    '---', 'title: "Video dài"', 'author: "Zuey"', `source: https://www.youtube.com/watch?v=${id}`, 'kind: youtube', '---', '',
    '# Video dài', '', '## Transcript', '',
    RAW_LINES.map(l => `**${l.split(' ')[0]}** · ${l.split(' ').slice(1).join(' ')}`).join('\n\n'), '',
  ].join('\n');
}

async function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  if (input.startsWith('https://anymd.cc/')) {
    const body: unknown = JSON.parse(String(init?.body));
    const url = typeof body === 'object' && body !== null && 'url' in body && typeof body.url === 'string' ? body.url : '';
    return parseYoutubeId(url) === VID ? new Response(anymdMarkdown(VID), { status: 200 }) : new Response('not found', { status: 404 });
  }
  if (input.startsWith('https://www.youtube.com/watch')) {
    return new Response('<html><script>var x = {"lengthSeconds":"120","shortDescription":"d"};</script></html>', { status: 200 });
  }
  return new Response('unexpected', { status: 500 });
}

/** Text the model receives as the user message. */
function userText(input: Record<string, unknown>): string {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const last: unknown = messages[messages.length - 1];
  return typeof last === 'object' && last !== null && 'content' in last && typeof last.content === 'string' ? last.content : '';
}

/** Behaves like a faithful cleanup model: same words, two capitalised paragraphs. */
function cleaningAi(): WorkersAiLike & { calls: number } {
  return {
    calls: 0,
    async run(_model, input) {
      this.calls++;
      const list = userText(input).split(' ');
      const half = Math.ceil(list.length / 2);
      const para = (ws: string[]) => `${ws.join(' ').replace(/^./, c => c.toUpperCase())}.`;
      return { response: `${para(list.slice(0, half))}\n\n${para(list.slice(half))}` };
    },
  };
}

const summarizingAi: WorkersAiLike = { async run() { return { response: 'Tóm tắt ngắn.' }; } };
const brokenAi: WorkersAiLike = { async run() { throw new Error('model overloaded'); } };

describe('transcript timing and chunking', () => {
  it('spreads words across a segment and ends the last one at the video duration', () => {
    const tw = timedWords('0:00 a b c d\n0:10 e f', 20);
    expect(tw.map(w => w.time)).toEqual([0, 2.5, 5, 7.5, 10, 15]);
  });

  it('chunks long text, prefers caption boundaries and keeps every word', () => {
    const transcript = Array.from({ length: 10 }, (_, i) => `${i}:00 ${words(150, `s${i}x`)}`).join('\n');
    const chunks = chunkTranscript(transcript, 600, 600);
    expect(chunks.reduce((n, c) => n + c.words, 0)).toBe(1500);
    expect(chunks[0].words).toBe(600);
    expect(chunks[1].start).toBe(240);
    expect(chunks[chunks.length - 1].end).toBe(600);
    // A single giant segment is still cut at the size limit.
    expect(chunkTranscript(`0:00 ${words(1300)}`, null, 600).map(c => c.words)).toEqual([600, 600, 100]);
  });

  it('formats timestamps and places paragraphs proportionally inside a chunk', () => {
    expect(formatTimestamp(65)).toBe('1:05');
    expect(formatTimestamp(3723)).toBe('1:02:03');
    const lines = placeParagraphs({ start: 60, end: 120, text: '', words: 4 }, ['A b.', 'C d.']);
    expect(lines).toEqual(['1:00 A b.', '1:30 C d.']);
    expect(parseParagraphs('## Heading\n\n- one\ntwo\n\n\nthree')).toEqual(['Heading', 'one two', 'three']);
  });
});

describe('AI rewrite', () => {
  it('rewrites into timestamped paragraphs with the default model', async () => {
    const ai = cleaningAi();
    let model = '';
    const spy: WorkersAiLike = { run: (m, input) => { model = m; return ai.run(m, input); } };
    const out = await rewriteTranscript([workersAiRewriter(spy)], RAW_LINES[0], { durationSeconds: 60 });
    expect(model).toBe(DEFAULT_WORKERS_AI_REWRITE_MODEL);
    expect(out.model).toBe(`workers-ai:${DEFAULT_WORKERS_AI_REWRITE_MODEL}`);
    const segs = transcriptSegments(out.transcript);
    expect(segs.length).toBe(2);
    expect(segs[0].start).toBe(0);
    expect(segs[1].start).toBeGreaterThan(0);
    expect(segs[0].text.startsWith('Xin0')).toBe(true);
  });

  it('rejects output that drops most of the words (summaries)', async () => {
    await expect(rewriteTranscript([workersAiRewriter(summarizingAi)], RAW_LINES[0])).rejects.toMatchObject({ code: 'rewrite_failed' });
    await expect(rewriteTranscript([], RAW_LINES[0])).rejects.toMatchObject({ status: 503 });
  });

  it('runs after a fetch, keeps the raw source and re-indexes the cleaned text', async () => {
    const ai = cleaningAi();
    const added = await addVideo({ db: d1, fetchImpl: fakeFetch, ai }, { url: VID, locale: 'vi' });
    expect(added.transcript_rewrite_status).toBe('ready');
    const edition = await getEdition(d1, VID, { transcript: true });
    expect(edition?.transcript_rewrite_status).toBe('ready');
    expect(edition?.transcript).toContain('Xin0');
    expect(await getTranscriptSource(d1, VID)).toBe(RAW_LINES[0]);
    expect(JSON.stringify(await searchVideos(d1, 'zebracornflake', { limit: 5, origin: ORIGIN, locale: null }))).toContain(VID);

    // A refetch replaces the source; without AI the raw captions are shown again.
    await refetchTranscript({ db: d1, fetchImpl: fakeFetch }, VID);
    const raw = await getEdition(d1, VID, { transcript: true });
    expect(raw?.transcript_rewrite_status).toBe('none');
    expect(raw?.transcript).toBe(RAW_LINES[0]);
  });

  it('prefers OpenRouter and falls back to Workers AI per chunk', async () => {
    await addVideo({ db: d1, fetchImpl: fakeFetch }, { url: VID, locale: 'vi' });
    const sent: Array<{ model: string; auth: string | null }> = [];
    const openRouter = (status: number) => async (input: string, init?: RequestInit): Promise<Response> => {
      if (!input.startsWith('https://openrouter.ai/')) return fakeFetch(input, init);
      const body: unknown = JSON.parse(String(init?.body));
      const model = typeof body === 'object' && body !== null && 'model' in body && typeof body.model === 'string' ? body.model : '';
      sent.push({ model, auth: new Headers(init?.headers).get('Authorization') });
      if (status !== 200) return new Response(JSON.stringify({ error: { message: 'no capacity' } }), { status });
      const user = typeof body === 'object' && body !== null && 'messages' in body ? userText({ messages: body.messages }) : '';
      return new Response(JSON.stringify({ choices: [{ message: { content: `${user}.` } }] }), { status: 200 });
    };
    const modelOf = () => d1.raw.query("SELECT transcript_rewrite_model AS m FROM video_editions WHERE youtube_id = ?").get(VID);

    const viaOpenRouter = await rewriteEditionTranscript({ db: d1, fetchImpl: openRouter(200), openRouterApiKey: 'test-key', ai: brokenAi }, VID);
    expect(viaOpenRouter.transcript_rewrite_status).toBe('ready');
    expect(sent[0]).toEqual({ model: DEFAULT_OPENROUTER_REWRITE_MODEL, auth: 'Bearer test-key' });
    expect(modelOf()).toEqual({ m: `openrouter:${DEFAULT_OPENROUTER_REWRITE_MODEL}` });

    const fallback = await rewriteEditionTranscript({ db: d1, fetchImpl: openRouter(503), openRouterApiKey: 'test-key', ai: cleaningAi() }, VID);
    expect(fallback.transcript_rewrite_status).toBe('ready');
    expect(modelOf()).toEqual({ m: `workers-ai:${DEFAULT_WORKERS_AI_REWRITE_MODEL}` });

    const bothDown = await rewriteEditionTranscript({ db: d1, fetchImpl: openRouter(503), openRouterApiKey: 'test-key', ai: brokenAi }, VID);
    expect(bothDown.transcript_rewrite_status).toBe('failed');
    expect(bothDown.transcript_rewrite_error).toContain('model overloaded');
  });

  it('keeps the raw text and records the error when the model fails', async () => {
    await addVideo({ db: d1, fetchImpl: fakeFetch }, { url: VID, locale: 'vi' });
    const result = await rewriteEditionTranscript({ db: d1, ai: brokenAi }, VID);
    expect(result.transcript_rewrite_status).toBe('failed');
    expect(result.transcript_rewrite_error).toContain('model overloaded');
    const edition = await getEdition(d1, VID, { transcript: true });
    expect(edition?.transcript).toBe(RAW_LINES[0]);
    await expect(rewriteEditionTranscript({ db: d1 }, VID)).rejects.toMatchObject({ status: 503 });
  });
});

describe('proper-noun glossary', () => {
  it('parses extra names with mis-hearings and lets them override defaults', () => {
    const extra = parseGlossary('Hermes = Han Harris | Hermit,\n Kongming ,, codex = Codecs');
    expect(extra).toEqual([{ term: 'Hermes', heardAs: ['Han Harris', 'Hermit'] }, { term: 'Kongming' }, { term: 'codex', heardAs: ['Codecs'] }]);
    const merged = mergeGlossary(DEFAULT_REWRITE_GLOSSARY, extra);
    expect(merged.length).toBe(DEFAULT_REWRITE_GLOSSARY.length + 2);
    expect(merged.find(t => t.term.toLowerCase() === 'codex')).toEqual({ term: 'codex', heardAs: ['Codecs'] });
    expect(parseGlossary(undefined)).toEqual([]);
  });

  it('sends the title, defaults and env extras to the model as the system prompt', async () => {
    expect(buildSystemPrompt()).not.toContain('proper nouns');
    const prompt = buildSystemPrompt({ title: 'Giới thiệu AgentKit', glossary: DEFAULT_REWRITE_GLOSSARY });
    expect(prompt).toContain('"Giới thiệu AgentKit"');
    expect(prompt).toContain('- Kongming (may be mis-heard as "Coming"; replace only when it names the advisor sub-agent, never the verb "coming")');
    expect(prompt).toContain('- ClaudeKit (may be mis-heard as "ClockKit", "Clock Kit", "Clock Kid", "Cloud Kit", "Clockwork")');

    const systems: string[] = [];
    const ai = cleaningAi();
    const spy: WorkersAiLike = {
      run: (m, input) => {
        const first: unknown = Array.isArray(input.messages) ? input.messages[0] : null;
        if (typeof first === 'object' && first !== null && 'content' in first && typeof first.content === 'string') systems.push(first.content);
        return ai.run(m, input);
      },
    };
    await addVideo({ db: d1, fetchImpl: fakeFetch }, { url: VID, locale: 'vi' });
    await rewriteEditionTranscript({ db: d1, ai: spy, rewriteGlossary: 'Hermes = Han Harris' }, VID);
    expect(systems[0]).toContain('"Video dài"');
    expect(systems[0]).toContain('- Hermes (may be mis-heard as "Han Harris")');
    expect(systems[0]).toContain('- Codex (may be mis-heard as "Codax", "Cortex")');
  });
});

describe('rewrite surfaces', () => {
  async function callRewrite(handler: APIRoute, headers: Record<string, string>): Promise<Response> {
    const request = new Request(`${ORIGIN}/api/v1/videos/${VID}/rewrite`, { method: 'POST', headers });
    const context = { request, params: { id: VID }, url: new URL(request.url), locals: { runtime: { env: { DB: d1, AI: cleaningAi(), PUBLIC_SITE_URL: ORIGIN } } } };
    // The handler only reads request/params/locals; a full APIContext is not constructible in tests.
    return handler(context as unknown as Parameters<APIRoute>[0]);
  }

  it('REST rewrite is admin-only; MCP tool and OpenAPI path are registered', async () => {
    await addVideo({ db: d1, fetchImpl: fakeFetch }, { url: VID, locale: 'vi' });
    expect((await callRewrite(rewriteApi, {})).status).toBe(401);
    const cookie = `zuey_session=${await createSession('admin@zuey.me', d1)}`;
    const res = await callRewrite(rewriteApi, { cookie });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(JSON.stringify(body)).toContain('"transcript_rewrite_status":"ready"');

    expect(allMcpTools().map(t => t.name)).toContain('video_rewrite_transcript');
    expect(TOOL_ACCESS.video_rewrite_transcript).toEqual({ kind: 'admin' });
    expect(OPENAPI_FRAGMENTS.flatMap(f => Object.keys(f.paths ?? {}))).toContain('/api/v1/videos/{id}/rewrite');
  });
});
