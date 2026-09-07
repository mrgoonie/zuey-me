import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  getProfile,
  updateProfile,
  getLinks,
  createLink,
  updateLink,
  deleteLink,
  reorderLinks,
  createApiKey,
  verifyApiKey,
  revokeApiKey,
  hashString,
} from '../src/db/store';
import { initialProfile, initialLinks, initialSocials } from '../src/db/data';
import { execSync } from 'node:child_process';

// Import API route handlers directly
import { GET as getProfileApi, PUT as putProfileApi } from '../src/pages/api/v1/profile';
import { GET as getLinksApi, POST as postLinksApi } from '../src/pages/api/v1/links/index';
import { PUT as putLinkApi, DELETE as deleteLinkApi } from '../src/pages/api/v1/links/[id]';
import { POST as reorderLinksApi } from '../src/pages/api/v1/links/reorder';
import { GET as getThemeApi, PUT as putThemeApi } from '../src/pages/api/v1/theme';
import { GET as getKeysApi, POST as postKeysApi } from '../src/pages/api/v1/keys/index';
import { DELETE as deleteKeyApi } from '../src/pages/api/v1/keys/[id]';
import { POST as mcpApi } from '../src/pages/api/mcp';
import { GET as openApiSpec } from '../src/pages/api/openapi.json';
import { GET as getIndexMd } from '../src/pages/index.md';
import { GET as getLinksMd } from '../src/pages/links.md';
import { GET as getProfileMd } from '../src/pages/profile.md';
import { GET as getLlmsTxt } from '../src/pages/llms.txt';
import { GET as getOgPng } from '../src/pages/api/og.png';

describe('Zuey.me Data Consistency', () => {
  it('should have initial profile matching requirements', () => {
    expect(initialProfile.name).toBe('Duy Nguyen /zuey/');
    expect(initialProfile.email).toBe('hi@zuey.me');
    expect(initialProfile.avatar_url).toBe('https://cdn.zuey.me/avatar.png');
    expect(initialProfile.intro_en).toContain('F*ck Around & Find Out');
    expect(initialProfile.intro_en).toContain('TOPGROUP');
    expect(initialProfile.intro_vi).toContain('Build in Public VN');
  });

  it('should contain updated YouTube link to @imzuey', () => {
    const yt = initialSocials.find(s => s.platform === 'youtube');
    expect(yt).toBeDefined();
    expect(yt?.url).toBe('https://youtube.com/@imzuey');
  });
  it('should contain updated WhatsApp link to @imzuey', () => {
    const wa = initialSocials.find(s => s.platform === 'whatsapp');
    expect(wa).toBeDefined();
    expect(wa?.url).toBe('https://wa.me/imzuey');
  });

  it('should contain all required blog links', () => {
    const blogs = initialLinks.filter(l => l.section === 'blogs');
    expect(blogs.length).toBe(2);
    expect(blogs.some(b => b.url.includes('faafospecialist.substack.com'))).toBe(true);
    expect(blogs.some(b => b.url.includes('goonnguyen.substack.com'))).toBe(true);
  });

  it('should contain all required company links', () => {
    const companies = initialLinks.filter(l => l.section === 'companies');
    expect(companies.length).toBeGreaterThanOrEqual(6);
    expect(companies.some(c => c.url.includes('wearetopgroup.com'))).toBe(true);
    expect(companies.some(c => c.url.includes('digitop.ai'))).toBe(true);
    expect(companies.some(c => c.url.includes('xinchao.world'))).toBe(true);
    expect(companies.some(c => c.url.includes('nextlevelbuilder.io'))).toBe(true);
    expect(companies.some(c => c.url.includes('tose.sh'))).toBe(true);
    expect(companies.some(c => c.url.includes('bip.vn'))).toBe(true);
  });

  it('should contain all required product links', () => {
    const products = initialLinks.filter(l => l.section === 'products');
    expect(products.length).toBeGreaterThanOrEqual(12);
    expect(products.some(p => p.url.includes('agentkit.best'))).toBe(true);
    expect(products.some(p => p.url.includes('dewee.sh'))).toBe(true);
    expect(products.some(p => p.url.includes('goclaw.sh'))).toBe(true);
    expect(products.some(p => p.url.includes('indieboosting.com'))).toBe(true);
    expect(products.some(p => p.url.includes('uupm.cc'))).toBe(true);
    expect(products.some(p => p.url.includes('agentwiki.cc'))).toBe(true);
    expect(products.some(p => p.url.includes('agentbrain.sh'))).toBe(true);
    expect(products.some(p => p.url.includes('skillx.sh'))).toBe(true);
    expect(products.some(p => p.url.includes('findyourai.tools'))).toBe(true);
    expect(products.some(p => p.url.includes('vidcap.zuey.me'))).toBe(true);
    expect(products.some(p => p.url.includes('reviewweb.site'))).toBe(true);
  });
});

describe('Zuey.me Store CRUD & Operations', () => {
  it('should get and update profile', async () => {
    const profile = await getProfile();
    expect(profile.name).toBe('Duy Nguyen /zuey/');

    const updated = await updateProfile({ theme: 'dark' });
    expect(updated.theme).toBe('dark');

    // restore
    await updateProfile({ theme: 'ivory' });
  });

  it('should support link creation, update, and deletion', async () => {
    const initialCount = (await getLinks()).length;

    const newLink = await createLink({
      section: 'products',
      title_en: 'Test Product',
      title_vi: 'Sản phẩm thử nghiệm',
      url: 'https://test.zuey.me',
      is_active: true,
    });
    expect(newLink.id).toBeDefined();
    expect((await getLinks()).length).toBe(initialCount + 1);

    const updated = await updateLink(newLink.id, { title_en: 'Updated Test Product' });
    expect(updated?.title_en).toBe('Updated Test Product');

    const deleted = await deleteLink(newLink.id);
    expect(deleted).toBe(true);
    expect((await getLinks()).length).toBe(initialCount);
  });

  it('should reorder links correctly', async () => {
    const links = await getLinks();
    const order = [links[1].id, links[0].id];
    const success = await reorderLinks(order);
    expect(success).toBe(true);
  });

  it('should generate and verify API keys', async () => {
    const { key, record } = await createApiKey('Test CI Key');
    expect(key).toBeDefined();
    expect(record.name).toBe('Test CI Key');

    const isValid = await verifyApiKey(key);
    expect(isValid).toBe(true);

    const isInvalid = await verifyApiKey('invalid_key_123');
    expect(isInvalid).toBe(false);

    const revoked = await revokeApiKey(record.id);
    expect(revoked).toBe(true);
  });

  it('should hash strings consistently with SHA-256', async () => {
    const h1 = await hashString('hello');
    const h2 = await hashString('hello');
    expect(h1).toBe(h2);
    expect(h1.length).toBe(64);
  });
});

describe('Zuey.me API Route Handlers', () => {
  const mockContext = (options: { method?: string; body?: unknown; headers?: Record<string, string>; params?: Record<string, string> } = {}) => {
    const { method = 'GET', body, headers = {}, params = {} } = options;
    const reqHeaders = new Headers(headers);
    if (body) reqHeaders.set('Content-Type', 'application/json');

    const request = new Request('http://localhost:4321/test', {
      method,
      headers: reqHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });

    return {
      request,
      params,
      locals: {
        runtime: {
          env: {},
        },
      },
      redirect: (url: string, status = 302) => new Response(null, { status, headers: { Location: url } }),
    } as any;
  };

  it('GET /api/v1/profile should return profile data', async () => {
    const res = await getProfileApi(mockContext());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.data.name).toBe('Duy Nguyen /zuey/');
  });

  it('PUT /api/v1/profile should enforce auth and update', async () => {
    // Without auth -> 401
    const unauth = await putProfileApi(mockContext({ method: 'PUT', body: { name: 'New Name' } }));
    expect(unauth.status).toBe(401);

    // With auth -> 200
    const auth = await putProfileApi(mockContext({
      method: 'PUT',
      headers: { Authorization: 'Bearer zuey_live_demo_key' },
      body: { name: 'Duy Nguyen /zuey/' },
    }));
    expect(auth.status).toBe(200);
  });

  it('GET and PUT /api/v1/theme should work correctly', async () => {
    const getRes = await getThemeApi(mockContext());
    expect(getRes.status).toBe(200);
    const themeData = await getRes.json();
    expect(themeData.data.theme).toBeDefined();

    const putRes = await putThemeApi(mockContext({
      method: 'PUT',
      headers: { Authorization: 'Bearer zuey_live_demo_key' },
      body: { theme: 'dark' },
    }));
    expect(putRes.status).toBe(200);

    // restore
    await putThemeApi(mockContext({
      method: 'PUT',
      headers: { Authorization: 'Bearer zuey_live_demo_key' },
      body: { theme: 'ivory' },
    }));
  });

  it('Links CRUD and Reorder API handlers should function', async () => {
    // GET links
    const listRes = await getLinksApi(mockContext());
    expect(listRes.status).toBe(200);
    const links = (await listRes.json()).data;
    expect(links.length).toBeGreaterThanOrEqual(10);

    // POST create link
    const createRes = await postLinksApi(mockContext({
      method: 'POST',
      headers: { Authorization: 'Bearer zuey_live_demo_key' },
      body: { section: 'products', title_en: 'Route Test Link', url: 'https://test.me' },
    }));
    expect(createRes.status).toBe(201);
    const createdLink = (await createRes.json()).data;

    // PUT update link
    const updateRes = await putLinkApi(mockContext({
      method: 'PUT',
      params: { id: createdLink.id },
      headers: { Authorization: 'Bearer zuey_live_demo_key' },
      body: { title_en: 'Route Test Link Renamed' },
    }));
    expect(updateRes.status).toBe(200);

    // POST reorder links
    const reorderRes = await reorderLinksApi(mockContext({
      method: 'POST',
      headers: { Authorization: 'Bearer zuey_live_demo_key' },
      body: { order: [createdLink.id, links[0].id] },
    }));
    expect(reorderRes.status).toBe(200);

    // DELETE link
    const deleteRes = await deleteLinkApi(mockContext({
      method: 'DELETE',
      params: { id: createdLink.id },
      headers: { Authorization: 'Bearer zuey_live_demo_key' },
    }));
    expect(deleteRes.status).toBe(200);
  });

  it('API Keys handlers should list, create, and revoke', async () => {
    // List keys
    const listRes = await getKeysApi(mockContext({
      headers: { Authorization: 'Bearer zuey_live_demo_key' },
    }));
    expect(listRes.status).toBe(200);

    // Create key
    const createRes = await postKeysApi(mockContext({
      method: 'POST',
      headers: { Authorization: 'Bearer zuey_live_demo_key' },
      body: { name: 'Integration Test Key' },
    }));
    expect(createRes.status).toBe(201);
    const newKey = (await createRes.json()).data;
    expect(newKey.key).toBeDefined();

    // Revoke key
    const deleteRes = await deleteKeyApi(mockContext({
      method: 'DELETE',
      params: { id: newKey.record.id },
      headers: { Authorization: 'Bearer zuey_live_demo_key' },
    }));
    expect(deleteRes.status).toBe(200);
  });

  it('MCP Server endpoint should handle JSON-RPC initialize and tools/list', async () => {
    // initialize
    const initRes = await mcpApi(mockContext({
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    }));
    expect(initRes.status).toBe(200);
    const initData = await initRes.json();
    expect(initData.result.serverInfo.name).toBe('zuey-me-mcp');

    // tools/list
    const toolsRes = await mcpApi(mockContext({
      method: 'POST',
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    }));
    expect(toolsRes.status).toBe(200);
    const toolsData = await toolsRes.json();
    expect(toolsData.result.tools.length).toBeGreaterThanOrEqual(8);
  });

  it('OpenAPI spec, Markdown, and LLM routes should return valid content', async () => {
    const specRes = await openApiSpec(mockContext());
    expect(specRes.status).toBe(200);
    expect(specRes.headers.get('Content-Type')).toContain('application/json');

    const indexMdRes = await getIndexMd(mockContext());
    expect(indexMdRes.status).toBe(200);
    expect(indexMdRes.headers.get('Content-Type')).toContain('text/markdown');

    const linksMdRes = await getLinksMd(mockContext());
    expect(linksMdRes.status).toBe(200);

    const profileMdRes = await getProfileMd(mockContext());
    expect(profileMdRes.status).toBe(200);

    const llmsRes = await getLlmsTxt(mockContext());
    expect(llmsRes.status).toBe(200);
  });

  it('OG PNG route should redirect to raster /og.png and public/og.png should exist', async () => {
    const ogRes = await getOgPng(mockContext());
    expect(ogRes.status).toBe(302);
    expect(ogRes.headers.get('Location')).toBe('/og.png');

    const ogPath = path.resolve('public/og.png');
    expect(fs.existsSync(ogPath)).toBe(true);
    const stat = fs.statSync(ogPath);
    expect(stat.size).toBeGreaterThan(100000); // 250KB real raster PNG
  });
});

describe('Zuey.me CLI Execution', () => {
  it('should display CLI help output via node binary', () => {
    const output = execSync('node packages/cli/bin/zuey.js --help').toString();
    expect(output).toContain('Zuey.me CLI');
    expect(output).toContain('profile view');
    expect(output).toContain('links list');
    expect(output).toContain('mcp');
  });
});
