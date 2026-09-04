import { describe, it, expect } from 'vitest';
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
import { initialProfile, initialLinks } from '../src/db/data';
import { execSync } from 'node:child_process';

describe('Zuey.me Data Consistency', () => {
  it('should have initial profile matching requirements', () => {
    expect(initialProfile.name).toBe('Duy Nguyen /zuey/');
    expect(initialProfile.email).toBe('hi@zuey.me');
    expect(initialProfile.avatar_url).toBe('https://cdn.zuey.me/avatar.png');
    expect(initialProfile.intro_en).toContain('F*ck Around & Find Out');
    expect(initialProfile.intro_en).toContain('TOPGROUP');
    expect(initialProfile.intro_vi).toContain('Build in Public VN');
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

    // Create
    const newLink = await createLink({
      section: 'products',
      title_en: 'Test Product',
      title_vi: 'Sản phẩm thử nghiệm',
      url: 'https://test.zuey.me',
      is_active: true,
    });
    expect(newLink.id).toBeDefined();
    expect((await getLinks()).length).toBe(initialCount + 1);

    // Update
    const updated = await updateLink(newLink.id, { title_en: 'Updated Test Product' });
    expect(updated?.title_en).toBe('Updated Test Product');

    // Delete
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

describe('Zuey.me CLI Execution', () => {
  it('should display CLI help output via node binary', () => {
    const output = execSync('node packages/cli/bin/zuey.js --help').toString();
    expect(output).toContain('Zuey.me CLI');
    expect(output).toContain('profile view');
    expect(output).toContain('links list');
    expect(output).toContain('mcp');
  });
});
