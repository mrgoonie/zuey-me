import { initialProfile, initialLinks } from './data';
import type { Profile, LinkItem, ApiKey } from './types';

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}
// In-memory fallback for local dev / tests when Cloudflare D1 is not present
let memoryProfile: Profile = { ...initialProfile };
let memoryLinks: LinkItem[] = [...initialLinks];
let memoryApiKeys: ApiKey[] = [];

export async function hashString(str: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function getProfile(d1?: D1DatabaseLike): Promise<Profile> {
  if (d1) {
    try {
      const res = await d1.prepare('SELECT * FROM profiles WHERE id = ?').bind('main').first<Profile>();
      if (res) return res;
    } catch (e) {
      console.warn('D1 getProfile fallback:', e);
    }
  }
  return memoryProfile;
}

export async function updateProfile(data: Partial<Profile>, d1?: D1DatabaseLike): Promise<Profile> {
  if (d1) {
    try {
      const current = await getProfile(d1);
      const updated = { ...current, ...data, updated_at: new Date().toISOString() };
      await d1.prepare(`
        INSERT INTO profiles (id, name, handle, email, avatar_url, intro_en, intro_vi, theme, custom_css, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          handle = excluded.handle,
          email = excluded.email,
          avatar_url = excluded.avatar_url,
          intro_en = excluded.intro_en,
          intro_vi = excluded.intro_vi,
          theme = excluded.theme,
          custom_css = excluded.custom_css,
          updated_at = excluded.updated_at
      `).bind(
        updated.id,
        updated.name,
        updated.handle,
        updated.email,
        updated.avatar_url,
        updated.intro_en,
        updated.intro_vi,
        updated.theme,
        updated.custom_css || null,
        updated.updated_at
      ).run();
      return updated;
    } catch (e) {
      console.warn('D1 updateProfile fallback:', e);
    }
  }
  memoryProfile = { ...memoryProfile, ...data, updated_at: new Date().toISOString() };
  return memoryProfile;
}

export async function getLinks(d1?: D1DatabaseLike): Promise<LinkItem[]> {
  if (d1) {
    try {
      const res = await d1.prepare('SELECT * FROM links ORDER BY section ASC, order_index ASC').all<Record<string, unknown>>();
      if (res && res.results && res.results.length > 0) {
        return res.results.map((r) => {
          const item = r as unknown as LinkItem;
          return {
            ...item,
            is_active: Boolean(r.is_active),
          };
        });
      }
    } catch (e) {
      console.warn('D1 getLinks fallback:', e);
    }
  }
  return [...memoryLinks].sort((a, b) => a.order_index - b.order_index);
}

export async function getLinkById(id: string, d1?: D1DatabaseLike): Promise<LinkItem | null> {
  const links = await getLinks(d1);
  return links.find(l => l.id === id) || null;
}

export async function createLink(
  item: Omit<LinkItem, 'id' | 'order_index'>,
  d1?: D1DatabaseLike
): Promise<LinkItem> {
  const id = 'link-' + Math.random().toString(36).substring(2, 9);
  const currentLinks = await getLinks(d1);
  const sectionLinks = currentLinks.filter(l => l.section === item.section);
  const order_index = sectionLinks.length + 1;

  const newLink: LinkItem = {
    ...item,
    id,
    order_index,
    click_count: 0,
    updated_at: new Date().toISOString(),
  };

  if (d1) {
    try {
      await d1.prepare(`
        INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        newLink.id,
        newLink.section,
        newLink.title_en,
        newLink.title_vi,
        newLink.subtitle_en || null,
        newLink.subtitle_vi || null,
        newLink.url,
        newLink.icon || null,
        newLink.order_index,
        newLink.is_active ? 1 : 0,
        0
      ).run();
      return newLink;
    } catch (e) {
      console.warn('D1 createLink fallback:', e);
    }
  }

  memoryLinks.push(newLink);
  return newLink;
}

export async function updateLink(id: string, data: Partial<LinkItem>, d1?: D1DatabaseLike): Promise<LinkItem | null> {
  if (d1) {
    try {
      const current = await getLinkById(id, d1);
      if (!current) return null;
      const updated = { ...current, ...data, updated_at: new Date().toISOString() };
      await d1.prepare(`
        UPDATE links SET
          section = ?, title_en = ?, title_vi = ?, subtitle_en = ?, subtitle_vi = ?,
          url = ?, icon = ?, is_active = ?, updated_at = ?
        WHERE id = ?
      `).bind(
        updated.section,
        updated.title_en,
        updated.title_vi,
        updated.subtitle_en || null,
        updated.subtitle_vi || null,
        updated.url,
        updated.icon || null,
        updated.is_active ? 1 : 0,
        updated.updated_at,
        id
      ).run();
      return updated;
    } catch (e) {
      console.warn('D1 updateLink fallback:', e);
    }
  }

  const idx = memoryLinks.findIndex(l => l.id === id);
  if (idx === -1) return null;
  memoryLinks[idx] = { ...memoryLinks[idx], ...data, updated_at: new Date().toISOString() };
  return memoryLinks[idx];
}

export async function deleteLink(id: string, d1?: D1DatabaseLike): Promise<boolean> {
  if (d1) {
    try {
      await d1.prepare('DELETE FROM links WHERE id = ?').bind(id).run();
      return true;
    } catch (e) {
      console.warn('D1 deleteLink fallback:', e);
    }
  }

  const lenBefore = memoryLinks.length;
  memoryLinks = memoryLinks.filter(l => l.id !== id);
  return memoryLinks.length < lenBefore;
}

export async function reorderLinks(orderIds: string[], d1?: D1DatabaseLike): Promise<boolean> {
  if (d1) {
    try {
      for (let i = 0; i < orderIds.length; i++) {
        await d1.prepare('UPDATE links SET order_index = ? WHERE id = ?').bind(i + 1, orderIds[i]).run();
      }
      return true;
    } catch (e) {
      console.warn('D1 reorderLinks fallback:', e);
    }
  }

  orderIds.forEach((id, index) => {
    const item = memoryLinks.find(l => l.id === id);
    if (item) {
      item.order_index = index + 1;
    }
  });
  return true;
}

export async function incrementClick(id: string, d1?: D1DatabaseLike): Promise<void> {
  if (d1) {
    try {
      await d1.prepare('UPDATE links SET click_count = click_count + 1 WHERE id = ?').bind(id).run();
      return;
    } catch (e) {
      console.warn('D1 incrementClick fallback:', e);
    }
  }
  const item = memoryLinks.find(l => l.id === id);
  if (item) {
    item.click_count = (item.click_count || 0) + 1;
  }
}

export async function listApiKeys(d1?: D1DatabaseLike): Promise<ApiKey[]> {
  if (d1) {
    try {
      const res = await d1.prepare('SELECT id, key_prefix, name, role, created_at, last_used_at FROM api_keys').all<ApiKey>();
      if (res?.results) return res.results;
    } catch (e) {
      console.warn('D1 listApiKeys fallback:', e);
    }
  }
  return memoryApiKeys.map(({ key_hash, ...rest }) => ({ ...rest, key_hash: '' }));
}

export async function createApiKey(name: string, role: 'admin' | 'read' = 'admin', d1?: D1DatabaseLike): Promise<{ key: string; record: ApiKey }> {
  const rawToken = 'zuey_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
  const hash = await hashString(rawToken);
  const prefix = rawToken.substring(0, 10) + '...';
  const id = 'key-' + Math.random().toString(36).substring(2, 8);
  const now = new Date().toISOString();

  const record: ApiKey = {
    id,
    key_hash: hash,
    key_prefix: prefix,
    name,
    role,
    created_at: now,
  };

  if (d1) {
    try {
      await d1.prepare(`
        INSERT INTO api_keys (id, key_hash, key_prefix, name, role, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(id, hash, prefix, name, role, now).run();
    } catch (e) {
      console.warn('D1 createApiKey fallback:', e);
    }
  }

  memoryApiKeys.push(record);
  return { key: rawToken, record };
}

export async function verifyApiKey(token: string, d1?: D1DatabaseLike): Promise<boolean> {
  if (!token) return false;
  const hash = await hashString(token);

  if (d1) {
    try {
      const res = await d1.prepare('SELECT id FROM api_keys WHERE key_hash = ?').bind(hash).first<{ id: string }>();
      if (res) {
        d1.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
          .bind(new Date().toISOString(), res.id)
          .run()
          .catch(() => {});
        return true;
      }
    } catch (e) {
      console.warn('D1 verifyApiKey fallback:', e);
    }
  }

  return memoryApiKeys.some(k => k.key_hash === hash);
}

export async function revokeApiKey(id: string, d1?: D1DatabaseLike): Promise<boolean> {
  if (d1) {
    try {
      await d1.prepare('DELETE FROM api_keys WHERE id = ?').bind(id).run();
      return true;
    } catch (e) {
      console.warn('D1 revokeApiKey fallback:', e);
    }
  }
  const len = memoryApiKeys.length;
  memoryApiKeys = memoryApiKeys.filter(k => k.id !== id);
  return memoryApiKeys.length < len;
}

interface SessionRecord {
  id: string;
  token_hash: string;
  user_email: string;
  created_at: string;
  expires_at: string;
}

let memorySessions: SessionRecord[] = [];

export async function createSession(user_email: string, d1?: D1DatabaseLike): Promise<string> {
  const rawToken = 'zuey_sess_' + crypto.randomUUID().replace(/-/g, '') + Math.random().toString(36).substring(2);
  const hash = await hashString(rawToken);
  const id = 'sess-' + Math.random().toString(36).substring(2, 9);
  const now = new Date();
  const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const record: SessionRecord = {
    id,
    token_hash: hash,
    user_email,
    created_at: now.toISOString(),
    expires_at: expires,
  };

  if (d1) {
    try {
      await d1.prepare(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          user_email TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP NOT NULL
        )
      `).run();
      await d1.prepare(`
        INSERT INTO sessions (id, token_hash, user_email, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(id, hash, user_email, record.created_at, expires).run();
    } catch (e) {
      console.warn('D1 createSession fallback:', e);
    }
  }

  memorySessions.push(record);
  return rawToken;
}

export async function verifySession(token: string, d1?: D1DatabaseLike): Promise<boolean> {
  if (!token || !token.startsWith('zuey_sess_')) return false;
  const hash = await hashString(token);
  const now = new Date().toISOString();

  if (d1) {
    try {
      const res = await d1.prepare('SELECT id FROM sessions WHERE token_hash = ? AND expires_at > ?')
        .bind(hash, now)
        .first<{ id: string }>();
      if (res) return true;
    } catch (e) {
      console.warn('D1 verifySession fallback:', e);
    }
  }

  const mem = memorySessions.find(s => s.token_hash === hash && s.expires_at > now);
  return Boolean(mem);
}

export async function destroySession(token: string, d1?: D1DatabaseLike): Promise<void> {
  if (!token) return;
  const hash = await hashString(token);

  if (d1) {
    try {
      await d1.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
    } catch (e) {
      console.warn('D1 destroySession fallback:', e);
    }
  }

  memorySessions = memorySessions.filter(s => s.token_hash !== hash);
}
