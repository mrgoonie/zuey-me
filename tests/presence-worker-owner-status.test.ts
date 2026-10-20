import { describe, expect, it } from 'bun:test';
import { OWNER_MODES, OWNER_STATUS_TEXT_MAX, PRESENCE_TTL_MS, type OwnerMode } from '../src/lib/presence/contract';
import {
  DEFAULT_OWNER_SETTING, derivePublicOwner, isOwnerSetting, nextOwner, ownerConnected, ownerPresence, parseOwnerStatusUpdate,
  readStoredOwner, sanitizeOwnerText,
  type OwnerSetting, type StoredOwner,
} from '../workers/presence/src/owner-status';
import { applyClientMessage, newSession, type SessionIdentity, type SocketSession } from '../workers/presence/src/presence-state';

const T0 = Date.parse('2026-10-20T04:00:00.000Z');

const setting = (mode: OwnerMode, text: string | null = 'Writing the next course'): OwnerSetting => ({ mode, text, updatedAt: T0 });

function live(over: Partial<SessionIdentity> = {}, at = T0): SocketSession {
  const id: SessionIdentity = { k: 'owner', c: true, m: true, o: true, ipHash: 'ip', ...over };
  return applyClientMessage(newSession(id, at), { t: 'hb', cat: 'exploring' }, at);
}

/** Public JSON for a mode, starting from the same stored owner, as the hub would publish it. */
function publicJson(mode: OwnerMode, connected: boolean, prev: StoredOwner | null, now: number): string {
  return JSON.stringify(ownerPresence(nextOwner(prev, derivePublicOwner(setting(mode), connected), now)));
}

describe('owner connection', () => {
  it('needs an owner ticket with counting consent and a fresh heartbeat', () => {
    expect(ownerConnected([live()], T0)).toBe(true);
    expect(ownerConnected([live({ o: false })], T0)).toBe(false);
    expect(ownerConnected([live({ c: false })], T0)).toBe(false);
    expect(ownerConnected([live()], T0 + PRESENCE_TTL_MS + 1)).toBe(false);
    expect(ownerConnected([applyClientMessage(live(), { t: 'idle' }, T0)], T0)).toBe(false);
    expect(ownerConnected([newSession({ k: 'owner', c: true, m: true, o: true, ipHash: 'ip' }, T0)], T0)).toBe(false);
  });
});

describe('public owner derivation', () => {
  it('auto follows the connection', () => {
    expect(derivePublicOwner(setting('auto'), true)).toEqual({ status: 'online', onSite: true, text: 'Writing the next course' });
    expect(derivePublicOwner(setting('auto'), false)).toEqual({ status: 'offline', onSite: false, text: null });
  });

  it('away and busy keep their status; onSite follows the connection', () => {
    for (const mode of ['away', 'busy'] as const) {
      expect(derivePublicOwner(setting(mode), true)).toEqual({ status: mode, onSite: true, text: 'Writing the next course' });
      expect(derivePublicOwner(setting(mode), false)).toEqual({ status: mode, onSite: false, text: 'Writing the next course' });
    }
  });

  it('offline and invisible are always offline, off site and without text', () => {
    for (const mode of ['offline', 'invisible'] as const) {
      for (const connected of [true, false]) {
        expect(derivePublicOwner(setting(mode), connected)).toEqual({ status: 'offline', onSite: false, text: null });
      }
    }
  });

  it('omits text when none is set', () => {
    expect(ownerPresence(nextOwner(null, derivePublicOwner(setting('busy', null), true), T0))).toEqual({
      status: 'busy', onSite: true, since: new Date(T0).toISOString(),
    });
  });

  it('invisible and offline publish byte-identical owners, connected or not', () => {
    const prev = nextOwner(null, derivePublicOwner(setting('auto'), true), T0 - 60_000);
    for (const connected of [true, false]) {
      expect(publicJson('invisible', connected, prev, T0)).toBe(publicJson('offline', connected, prev, T0));
    }
  });

  it('switching offline <-> invisible never moves `since`', () => {
    const offline = nextOwner(null, derivePublicOwner(setting('offline'), true), T0);
    const invisible = nextOwner(offline, derivePublicOwner(setting('invisible'), true), T0 + 60_000);
    expect(invisible).toBe(offline);
    const auto = nextOwner(invisible, derivePublicOwner(setting('auto'), false), T0 + 120_000);
    expect(auto).toBe(offline);
  });

  it('moves `since` when status, onSite or text changes', () => {
    const away = nextOwner(null, derivePublicOwner(setting('away'), false), T0);
    expect(nextOwner(away, derivePublicOwner(setting('away'), true), T0 + 1).since).toBe(T0 + 1);
    expect(nextOwner(away, derivePublicOwner(setting('away', 'Lunch'), false), T0 + 2).since).toBe(T0 + 2);
    expect(nextOwner(away, derivePublicOwner(setting('busy'), false), T0 + 3).since).toBe(T0 + 3);
    expect(nextOwner(away, derivePublicOwner(setting('away'), false), T0 + 4)).toBe(away);
  });

  it('publishes only status, onSite, since and (when visible) text', () => {
    for (const mode of OWNER_MODES) {
      for (const connected of [true, false]) {
        const owner = ownerPresence(nextOwner(null, derivePublicOwner(setting(mode, 'secret-text'), connected), T0));
        const keys = Object.keys(owner).sort();
        expect(keys.every((k) => ['onSite', 'since', 'status', 'text'].includes(k))).toBe(true);
        if (owner.status === 'offline') expect(JSON.stringify(owner)).not.toContain('secret-text');
        expect(JSON.stringify(owner)).not.toContain(mode === 'invisible' ? 'invisible' : 'mode');
      }
    }
  });
});

describe('stored owner', () => {
  it('reads the current shape and the earlier online/offline shape', () => {
    const current: StoredOwner = { status: 'busy', onSite: true, text: 'x', since: T0 };
    expect(readStoredOwner(current)).toEqual(current);
    expect(readStoredOwner({ status: 'online', since: T0 })).toEqual({ status: 'online', onSite: true, text: null, since: T0 });
    expect(readStoredOwner({ status: 'offline', since: T0 })).toEqual({ status: 'offline', onSite: false, text: null, since: T0 });
  });

  it('rejects malformed stored values', () => {
    for (const v of [null, 'online', { status: 'invisible', since: T0 }, { status: 'online' }, { status: 'busy', since: T0 }, { status: 'away', onSite: 'yes', text: null, since: T0 }]) {
      expect(readStoredOwner(v)).toBeNull();
    }
  });

  it('guards the stored setting', () => {
    expect(isOwnerSetting(DEFAULT_OWNER_SETTING)).toBe(true);
    expect(isOwnerSetting(setting('invisible'))).toBe(true);
    expect(isOwnerSetting({ mode: 'hidden', text: null, updatedAt: 0 })).toBe(false);
    expect(isOwnerSetting({ mode: 'auto', text: 'x'.repeat(OWNER_STATUS_TEXT_MAX + 1), updatedAt: 0 })).toBe(false);
  });
});

describe('owner status update validation', () => {
  it('accepts every mode, with and without text', () => {
    for (const mode of OWNER_MODES) {
      expect(parseOwnerStatusUpdate({ mode })).toEqual({ ok: true, mode, text: null });
      expect(parseOwnerStatusUpdate({ mode, text: '  Recording  ' })).toEqual({ ok: true, mode, text: 'Recording' });
    }
  });

  it('rejects unknown modes and non-object bodies', () => {
    for (const body of [null, [], 'away', { mode: 'online' }, { mode: 'AWAY' }, {}, { text: 'hi' }]) {
      expect(parseOwnerStatusUpdate(body).ok).toBe(false);
    }
  });

  it('rejects non-string text and text over the limit', () => {
    expect(parseOwnerStatusUpdate({ mode: 'away', text: 42 }).ok).toBe(false);
    expect(parseOwnerStatusUpdate({ mode: 'away', text: null }).ok).toBe(false);
    expect(parseOwnerStatusUpdate({ mode: 'away', text: 'x'.repeat(OWNER_STATUS_TEXT_MAX + 1) }).ok).toBe(false);
    expect(parseOwnerStatusUpdate({ mode: 'away', text: ` ${'x'.repeat(OWNER_STATUS_TEXT_MAX)} ` })).toEqual({
      ok: true, mode: 'away', text: 'x'.repeat(OWNER_STATUS_TEXT_MAX),
    });
  });

  it('strips control and bidi override characters and clears empty text', () => {
    expect(sanitizeOwnerText('a\u0000b\u001bc\u007f\u009fd')).toBe('abcd');
    expect(sanitizeOwnerText('line1\nline2\tx')).toBe('line1 line2 x');
    expect(sanitizeOwnerText('\u202Eevil\u202C ok\u2066')).toBe('evil ok');
    expect(sanitizeOwnerText(' \n\t\u0000 ')).toBeNull();
    expect(parseOwnerStatusUpdate({ mode: 'busy', text: '   ' })).toEqual({ ok: true, mode: 'busy', text: null });
  });
});
