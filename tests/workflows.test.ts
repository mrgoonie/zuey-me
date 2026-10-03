import { beforeEach, describe, expect, it } from 'bun:test';
import path from 'node:path';
import type { APIContext } from 'astro';
import { createApiKey } from '../src/db/store';
import type { D1DatabaseLike } from '../src/db/store';
import { AppError } from '../src/lib/http';
import type { McpContext } from '../src/lib/mcp/types';
import { requireWorkflowAdmin } from '../src/lib/workflows/access';
import { workflowsMcpModule } from '../src/lib/workflows/mcp';
import { workflowsOpenApi } from '../src/lib/workflows/openapi';
import { scanText } from '../src/lib/workflows/secret-scan';
import type { SecretKind } from '../src/lib/workflows/secret-scan';
import { GET as listApi, POST as createApi } from '../src/pages/api/v1/workflows/index';
import { DELETE as deleteApi, GET as getApi, PUT as updateApi } from '../src/pages/api/v1/workflows/[slug]';
import { POST as publishApi } from '../src/pages/api/v1/workflows/[slug]/publish';
import { GET as detailMd } from '../src/pages/workflows/[slug].md';
import { GET as indexMd } from '../src/pages/workflows.md';
import { createTestD1 } from './helpers/d1';

const SECRET_OPENAI = 'sk-abcdefghijklmnopqrstuvwx1234';
const SECRET_GITHUB = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

let d1: D1DatabaseLike;
let adminKey: string;
let readKey: string;

beforeEach(async () => {
  d1 = createTestD1();
  adminKey = (await createApiKey('admin', 'admin', d1)).key;
  readKey = (await createApiKey('reader', 'read', d1)).key;
});

function ctx(opts: { method?: string; url?: string; key?: string; body?: unknown; slug?: string } = {}): APIContext {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  const request = new Request(`http://localhost:4321${opts.url ?? '/api/v1/workflows'}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  // Route handlers only read request, params and locals; the rest of APIContext is unused.
  const partial = { request, params: { slug: opts.slug }, locals: { runtime: { env: { DB: d1 } } } };
  return partial as unknown as APIContext;
}

async function body(res: Response): Promise<{ success: boolean; data?: unknown; error?: { code: string; findings?: unknown[]; current_revision?: number } }> {
  return res.json();
}

function draft(slug: string, extra: Record<string, unknown> = {}) {
  return {
    name: 'Ship a feature with Claude Code',
    slug,
    summary: 'Plan, implement, test and review a feature end to end.',
    tools: ['Claude Code', 'bun'],
    trigger: 'A new feature request lands in the backlog.',
    steps: [{ title: 'Plan', detail: 'Write the plan file' }, { title: 'Implement' }, { title: 'Test' }],
    metrics: [{ label: 'Time saved', value: '2h/feature' }],
    tags: ['dev'],
    expected_revision: 0,
    ...extra,
  };
}

async function create(slug: string, extra: Record<string, unknown> = {}) {
  const res = await createApi(ctx({ method: 'POST', key: adminKey, body: draft(slug, extra) }));
  expect(res.status).toBe(201);
  const json = await body(res);
  return json.data as { revision: number; findings: unknown[] };
}

async function publish(slug: string, payload: Record<string, unknown>) {
  return publishApi(ctx({ method: 'POST', url: `/api/v1/workflows/${slug}/publish`, key: adminKey, slug, body: payload }));
}

async function publicList() {
  return (await body(await listApi(ctx()))).data as Array<{ slug: string; name: string }>;
}

describe('workflows REST', () => {
  it('keeps new drafts out of the public list and requires confirm to publish', async () => {
    const created = await create('ship-feature');
    expect(created.revision).toBe(1);
    expect(await publicList()).toEqual([]);
    expect((await getApi(ctx({ url: '/api/v1/workflows/ship-feature', slug: 'ship-feature' }))).status).toBe(404);

    const noConfirm = await publish('ship-feature', { expected_revision: 1 });
    expect(noConfirm.status).toBe(400);
    expect((await body(noConfirm)).error?.code).toBe('confirmation_required');
  });

  it('requires expected_revision 0 on create', async () => {
    const res = await createApi(ctx({ method: 'POST', key: adminKey, body: draft('x-flow', { expected_revision: undefined }) }));
    expect(res.status).toBe(400);
  });

  it('blocks publishing drafts with secrets or personal data', async () => {
    const created = await create('leaky', {
      steps: [
        { title: 'Call OpenAI', detail: `export OPENAI_API_KEY=${SECRET_OPENAI}` },
        { title: 'Push', detail: `git push https://${SECRET_GITHUB}@github.com/x/y` },
        { title: 'Open', detail: 'cd /Users/duy/projects/app and mail duy@example.com' },
      ],
    });
    expect(created.findings.length).toBeGreaterThanOrEqual(4);

    const res = await publish('leaky', { expected_revision: 1, confirm: true });
    expect(res.status).toBe(422);
    const json = await body(res);
    expect(json.error?.code).toBe('secret_detected');
    const kinds = (json.error?.findings ?? []).map(f => (f && typeof f === 'object' && 'kind' in f ? f.kind : null));
    expect(kinds).toEqual(expect.arrayContaining(['openai_key', 'github_token', 'home_path', 'email']));
    const raw = JSON.stringify(json);
    expect(raw).not.toContain(SECRET_OPENAI);
    expect(raw).not.toContain(SECRET_GITHUB);
    expect(await publicList()).toEqual([]);
  });

  it('publishes clean drafts and serves public detail + markdown', async () => {
    await create('clean-flow');
    const res = await publish('clean-flow', { expected_revision: 1, confirm: true });
    expect(res.status).toBe(200);

    expect((await publicList()).map(w => w.slug)).toEqual(['clean-flow']);
    const detail = await getApi(ctx({ url: '/api/v1/workflows/clean-flow', slug: 'clean-flow' }));
    expect(detail.status).toBe(200);

    const md = await detailMd(ctx({ slug: 'clean-flow' }));
    const text = await md.text();
    expect(md.headers.get('content-type')).toContain('text/markdown');
    expect(text).toContain('# Ship a feature with Claude Code');
    expect(text).toContain('1. **Plan**');
    expect(await (await indexMd(ctx())).text()).toContain('/workflows/clean-flow.md');
    expect((await detailMd(ctx({ slug: 'missing' }))).status).toBe(404);
  });

  it('rejects stale expected_revision with 409 and current_revision', async () => {
    await create('rev-flow');
    const ok = await updateApi(ctx({ method: 'PUT', key: adminKey, slug: 'rev-flow', body: { summary: 'v2', expected_revision: 1 } }));
    expect(ok.status).toBe(200);
    const stale = await updateApi(ctx({ method: 'PUT', key: adminKey, slug: 'rev-flow', body: { summary: 'v3', expected_revision: 1 } }));
    expect(stale.status).toBe(409);
    const json = await body(stale);
    expect(json.error?.code).toBe('revision_conflict');
    expect(json.error?.current_revision).toBe(2);
  });

  it('keeps the public snapshot until the edited draft is republished', async () => {
    await create('snap-flow');
    await publish('snap-flow', { expected_revision: 1, confirm: true });
    const upd = await updateApi(ctx({ method: 'PUT', key: adminKey, slug: 'snap-flow', body: { name: 'Renamed draft', expected_revision: 2 } }));
    expect(upd.status).toBe(200);

    expect((await publicList())[0].name).toBe('Ship a feature with Claude Code');
    const admin = await getApi(ctx({ url: '/api/v1/workflows/snap-flow?include_drafts=1', key: adminKey, slug: 'snap-flow' }));
    const adminData = (await body(admin)).data as { name: string; status: string; has_unpublished_changes: boolean };
    expect(adminData).toMatchObject({ name: 'Renamed draft', status: 'draft', has_unpublished_changes: true });

    expect((await publish('snap-flow', { expected_revision: 3, confirm: true })).status).toBe(200);
    expect((await publicList())[0].name).toBe('Renamed draft');
  });

  it('soft-deletes with expected_revision and keeps the audit trail', async () => {
    await create('del-flow');
    await publish('del-flow', { expected_revision: 1, confirm: true });
    const missingRev = await deleteApi(ctx({ method: 'DELETE', key: adminKey, slug: 'del-flow' }));
    expect(missingRev.status).toBe(400);
    const res = await deleteApi(ctx({ method: 'DELETE', key: adminKey, slug: 'del-flow', url: '/api/v1/workflows/del-flow?expected_revision=2' }));
    expect(res.status).toBe(200);
    expect(await publicList()).toEqual([]);

    const row = await d1.prepare('SELECT deleted_at FROM workflows WHERE slug = ?').bind('del-flow').first<{ deleted_at: string | null }>();
    expect(row?.deleted_at).toBeTruthy();
    const audit = await d1.prepare('SELECT action, actor FROM workflow_audit ORDER BY rowid').all<{ action: string; actor: string }>();
    expect((audit.results ?? []).map(a => a.action)).toEqual(['create', 'publish', 'delete']);
    expect((audit.results ?? []).every(a => a.actor === 'api_key')).toBe(true);
  });

  it('enforces auth: 401 without credentials, 403 for read keys', async () => {
    expect((await createApi(ctx({ method: 'POST', body: draft('auth-flow') }))).status).toBe(401);
    expect((await createApi(ctx({ method: 'POST', key: readKey, body: draft('auth-flow') }))).status).toBe(403);
    expect((await listApi(ctx({ url: '/api/v1/workflows?include_drafts=1' }))).status).toBe(401);
    expect((await listApi(ctx({ url: '/api/v1/workflows?include_drafts=1', key: readKey }))).status).toBe(403);
  });
});

describe('workflows MCP module', () => {
  function mcpCtx(key?: string): McpContext {
    const request = new Request('http://localhost:4321/api/mcp', {
      method: 'POST',
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    return {
      request,
      env: {},
      d1,
      async requireAdmin() {
        await requireWorkflowAdmin(request, d1);
      },
      async isAdmin() {
        try {
          await requireWorkflowAdmin(request, d1);
          return true;
        } catch {
          return false;
        }
      },
    };
  }

  async function expectAppError(p: Promise<unknown>, status: number, code?: string) {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      if (err instanceof AppError) {
        expect(err.status).toBe(status);
        if (code) expect(err.code).toBe(code);
      }
      return;
    }
    throw new Error(`expected AppError ${status}`);
  }

  it('exposes all six tools', () => {
    expect(workflowsMcpModule.tools.map(t => t.name).sort()).toEqual(
      ['workflow_create', 'workflow_delete', 'workflow_get', 'workflow_list', 'workflow_publish', 'workflow_update'],
    );
  });

  it('mirrors REST behaviour', async () => {
    const admin = mcpCtx(adminKey);
    const call = (name: string, args: Record<string, unknown>, c = admin) => workflowsMcpModule.call(name, args, c);

    await expectAppError(call('workflow_create', draft('mcp-flow'), mcpCtx()), 401);
    await expectAppError(call('workflow_create', draft('mcp-flow'), mcpCtx(readKey)), 403);
    await call('workflow_create', draft('mcp-flow'));

    expect(await call('workflow_list', {}, mcpCtx())).toEqual([]);
    expect(await call('workflow_list', { include_drafts: true }, mcpCtx(readKey))).toEqual([]);
    expect((await call('workflow_list', { include_drafts: true })) as unknown[]).toHaveLength(1);
    await expectAppError(call('workflow_get', { slug: 'mcp-flow' }, mcpCtx()), 404);

    await expectAppError(call('workflow_publish', { slug: 'mcp-flow', expected_revision: 1 }), 400, 'confirmation_required');
    await call('workflow_update', { slug: 'mcp-flow', expected_revision: 1, trigger: `token ${SECRET_GITHUB}` });
    await expectAppError(call('workflow_update', { slug: 'mcp-flow', expected_revision: 1, summary: 'x' }), 409, 'revision_conflict');
    await expectAppError(call('workflow_publish', { slug: 'mcp-flow', expected_revision: 2, confirm: true }), 422, 'secret_detected');
    expect(await call('workflow_list', {}, mcpCtx())).toEqual([]);

    await call('workflow_update', { slug: 'mcp-flow', expected_revision: 2, trigger: 'Clean trigger' });
    await call('workflow_publish', { slug: 'mcp-flow', expected_revision: 3, confirm: true });
    expect(await call('workflow_get', { slug: 'mcp-flow' }, mcpCtx())).toMatchObject({ slug: 'mcp-flow', status: 'published' });

    await expectAppError(call('workflow_delete', { slug: 'mcp-flow', expected_revision: 4 }, mcpCtx(readKey)), 403);
    await call('workflow_delete', { slug: 'mcp-flow', expected_revision: 4 });
    expect(await call('workflow_list', {}, mcpCtx())).toEqual([]);
  });
});

describe('secret scanner and OpenAPI fragment', () => {
  it('detects every supported pattern with masked excerpts', () => {
    const samples: Array<[SecretKind, string]> = [
      ['openai_key', 'sk-proj-abcdefghijklmnopqrstu'],
      ['openai_key', 'sk-ant-api03-abcdefghijklmnop'],
      ['github_token', 'github_pat_11ABCDEFGHIJKLMNOPQRSTUV'],
      ['aws_access_key', 'AKIAIOSFODNN7EXAMPLE'],
      ['slack_token', 'xoxb-1234567890-abcdef'],
      ['private_key', '-----BEGIN RSA PRIVATE KEY-----'],
      ['bearer_token', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123'],
      ['home_path', '/home/duy/code'],
      ['home_path', 'C:\\Users\\duy\\code'],
      ['email', 'someone@example.org'],
    ];
    for (const [kind, text] of samples) {
      const findings = scanText('summary', text);
      expect(findings.map(f => f.kind)).toContain(kind);
      for (const f of findings) expect(f.excerpt.length).toBeLessThan(text.length + 20);
    }
    expect(scanText('summary', 'Plain text with no secrets, uses ~/projects')).toEqual([]);
  });

  it('documents all workflow paths and schemas', () => {
    expect(Object.keys(workflowsOpenApi.paths).sort()).toEqual([
      '/api/v1/workflows',
      '/api/v1/workflows/{slug}',
      '/api/v1/workflows/{slug}/publish',
    ]);
    expect(Object.keys(workflowsOpenApi.schemas).sort()).toEqual(['SecretFinding', 'Workflow', 'WorkflowInput']);
  });
});

describe('extract-workflows script', () => {
  type Redact = (text: string, options?: { username?: string }) => string;
  type Mine = (sessions: string[][], opts?: { minSessions?: number; top?: number }) => Array<{ steps: string[]; sessions: number }>;

  async function loadScript(): Promise<{ redact: Redact; mineNgrams: Mine }> {
    const file = path.join(import.meta.dir, '..', 'skills', 'zuey-me', 'workflows', 'scripts', 'extract-workflows.mjs');
    const mod: unknown = await import(file);
    if (typeof mod !== 'object' || mod === null || !('redact' in mod) || !('mineNgrams' in mod)) throw new Error('bad module');
    const { redact, mineNgrams } = mod;
    if (typeof redact !== 'function' || typeof mineNgrams !== 'function') throw new Error('bad exports');
    return { redact: (t, o) => String(redact(t, o)), mineNgrams: (s, o) => mineNgrams(s, o) };
  }

  it('redacts with the same patterns the server scans for', async () => {
    const { redact } = await loadScript();
    const input = `cd /Users/duy/app && export K=${SECRET_OPENAI} ${SECRET_GITHUB} mail duy@example.com AKIAIOSFODNN7EXAMPLE zueyuser`;
    const out = redact(input, { username: 'zueyuser' });
    expect(scanText('x', out)).toEqual([]);
    expect(out).not.toContain(SECRET_OPENAI);
    expect(out).not.toContain('zueyuser');
    expect(out).toContain('~/app');
  });

  it('finds tool sequences repeated across sessions', async () => {
    const { mineNgrams } = await loadScript();
    const seq = ['Read', 'Edit', '$ bun test'];
    const grams = mineNgrams([seq, ['Grep', ...seq], [...seq, 'Write'], ['Read']], { minSessions: 3 });
    expect(grams[0]).toEqual({ steps: seq, sessions: 3 });
  });
});
