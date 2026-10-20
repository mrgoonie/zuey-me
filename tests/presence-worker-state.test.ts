import { describe, expect, it } from 'bun:test';
import { PRESENCE_MAX_MESSAGE_BYTES, PRESENCE_TTL_MS } from '../src/lib/presence/contract';
import {
  MAX_SOCKETS_PER_IP, MAX_SOCKETS_PER_KEY, MAX_SOCKETS_TOTAL, MAX_STRIKES, RATE_BURST, RATE_REFILL_MS,
  applyClientMessage, computeSnapshot, consumeRate, isSocketSession, newSession, parseClientMessage,
  snapshotSignature, withinCaps,
  type SessionIdentity, type SocketSession,
} from '../workers/presence/src/presence-state';
import { nextOwner, ownerConnected, ownerPresence, type StoredOwner } from '../workers/presence/src/owner-status';
import type { ActivityCategory } from '../src/lib/presence/contract';

const T0 = Date.parse('2026-10-20T04:00:00.000Z');
const OFFLINE: StoredOwner = { status: 'offline', onSite: false, text: null, since: T0 - 60_000 };

function identity(k: string, over: Partial<SessionIdentity> = {}): SessionIdentity {
  return { k, c: true, m: false, o: false, ipHash: `ip-${k}`, ...over };
}

/** A socket that sent one heartbeat with `cat` at `at`. */
function live(k: string, cat: ActivityCategory, over: Partial<SessionIdentity> = {}, at = T0): SocketSession {
  return applyClientMessage(newSession(identity(k, over), at), { t: 'hb', cat }, at);
}

const snap = (sessions: SocketSession[], now = T0, owner = OFFLINE) => computeSnapshot(sessions, ownerPresence(owner), now);

describe('presence counting', () => {
  it('collapses multiple tabs of one key into one visitor', () => {
    expect(snap([live('a', 'reading'), live('a', 'ai'), live('a', 'reading')]).active).toBe(1);
  });

  it('counts two keys as two visitors', () => {
    expect(snap([live('a', 'reading'), live('b', 'reading')]).active).toBe(2);
  });

  it('never counts watch-only (c=false) sockets', () => {
    const s = snap([live('a', 'reading', { c: false }), live('b', 'ai', { c: false }), live('c', 'ai', { c: false })]);
    expect(s.active).toBe(0);
    expect(s.categories).toEqual([]);
  });

  it('does not count a socket before its first heartbeat', () => {
    expect(snap([newSession(identity('a'), T0)]).active).toBe(0);
  });

  it('drops an idle socket immediately and restores it on the next heartbeat', () => {
    const idle = applyClientMessage(live('a', 'reading'), { t: 'idle' }, T0 + 1);
    expect(snap([idle, live('b', 'reading')], T0 + 1).active).toBe(1);
    const back = applyClientMessage(idle, { t: 'hb', cat: 'ai' }, T0 + 2);
    expect(snap([back, live('b', 'reading')], T0 + 2).active).toBe(2);
  });

  it('keeps a key counted while one of its tabs is still live', () => {
    const idleTab = applyClientMessage(live('a', 'reading'), { t: 'idle' }, T0 + 1);
    expect(snap([idleTab, live('a', 'ai')], T0 + 1).active).toBe(1);
  });

  it('expires sessions whose last heartbeat is older than the TTL', () => {
    const sessions = [live('a', 'reading'), live('b', 'reading', {}, T0 + 30_000)];
    expect(snap(sessions, T0 + PRESENCE_TTL_MS).active).toBe(2);
    expect(snap(sessions, T0 + PRESENCE_TTL_MS + 1).active).toBe(1);
    expect(snap(sessions, T0 + 30_000 + PRESENCE_TTL_MS + 1).active).toBe(0);
  });
});

describe('owner presence', () => {
  it('excludes owner sockets from visitor counts', () => {
    const s = snap([live('owner', 'reading', { o: true, m: true }), live('a', 'reading')]);
    expect(s.active).toBe(1);
  });

  it('marks the owner online only while a fresh, non-idle owner socket exists', () => {
    const owner = live('owner', 'reading', { o: true });
    expect(ownerConnected([owner], T0)).toBe(true);
    expect(ownerConnected([owner], T0 + PRESENCE_TTL_MS + 1)).toBe(false);
    expect(ownerConnected([applyClientMessage(owner, { t: 'idle' }, T0)], T0)).toBe(false);
    expect(ownerConnected([live('a', 'reading')], T0)).toBe(false);
  });

  it('moves `since` only when the public owner status flips', () => {
    const offline = { status: 'offline', onSite: false, text: null } as const;
    const first = nextOwner(null, offline, T0);
    expect(first).toEqual({ ...offline, since: T0 });
    expect(nextOwner(first, offline, T0 + 5_000)).toBe(first);
    const online = nextOwner(first, { status: 'online', onSite: true, text: null }, T0 + 10_000);
    expect(online).toEqual({ status: 'online', onSite: true, text: null, since: T0 + 10_000 });
    const s = snap([], T0 + 20_000, online);
    expect(s.owner).toEqual({ status: 'online', onSite: true, since: new Date(T0 + 10_000).toISOString() });
    expect(snap([], T0, OFFLINE).owner.onSite).toBe(false);
  });
});

describe('small-group suppression', () => {
  it('hides categories and members when fewer than three are active', () => {
    const s = snap([live('a', 'reading', { m: true }), live('b', 'reading', { m: true })]);
    expect(s.active).toBe(2);
    expect(s.members).toBeNull();
    expect(s.categories).toEqual([]);
  });

  it('folds groups below three into other and shows members from three', () => {
    const s = snap([
      live('a', 'reading', { m: true }), live('b', 'reading', { m: true }), live('c', 'reading', { m: true }),
      live('d', 'ai'), live('e', 'courses'),
    ]);
    expect(s.active).toBe(5);
    expect(s.members).toBe(3);
    expect(s.categories).toEqual([{ id: 'reading', count: 3 }, { id: 'other', count: 2 }]);
  });

  it('hides members below three even when active is large', () => {
    const s = snap([live('a', 'ai', { m: true }), live('b', 'ai'), live('c', 'ai'), live('d', 'ai')]);
    expect(s.members).toBeNull();
    expect(s.categories).toEqual([{ id: 'ai', count: 4 }]);
  });

  it('uses each key\'s most recent heartbeat category', () => {
    const older = live('a', 'reading', {}, T0);
    const newer = live('a', 'ai', {}, T0 + 1_000);
    const s = snap([older, newer, live('b', 'ai'), live('c', 'ai')], T0 + 1_000);
    expect(s.categories).toEqual([{ id: 'ai', count: 3 }]);
  });

  it('publishes exactly the contract keys and nothing identifying', () => {
    const s = snap([live('secret-key-a', 'reading'), live('secret-key-b', 'reading'), live('secret-key-c', 'reading')]);
    expect(Object.keys(s).sort()).toEqual(['active', 'at', 'categories', 'members', 'owner', 'v']);
    expect(Object.keys(s.owner).sort()).toEqual(['onSite', 'since', 'status']);
    for (const c of s.categories) expect(Object.keys(c).sort()).toEqual(['count', 'id']);
    const text = JSON.stringify(s);
    expect(text).not.toContain('secret-key');
    expect(text).not.toContain('ip-');
  });

  it('signature ignores the computation time', () => {
    const sessions = [live('a', 'reading')];
    expect(snapshotSignature(snap(sessions, T0))).toBe(snapshotSignature(snap(sessions, T0 + 1_000)));
  });
});

describe('client messages', () => {
  it('parses the four message types', () => {
    expect(parseClientMessage('{"t":"hb","cat":"reading"}')).toEqual({ t: 'hb', cat: 'reading' });
    expect(parseClientMessage('{"t":"idle"}')).toEqual({ t: 'idle' });
    expect(parseClientMessage('{"t":"sub"}')).toEqual({ t: 'sub' });
    expect(parseClientMessage('{"t":"unsub"}')).toEqual({ t: 'unsub' });
  });

  it('ignores invalid categories', () => {
    expect(parseClientMessage('{"t":"hb","cat":"https://zuey.me/private"}')).toBeNull();
    expect(parseClientMessage('{"t":"hb"}')).toBeNull();
  });

  it('rejects oversize, binary, non-JSON and unknown messages', () => {
    expect(parseClientMessage(`{"t":"idle","pad":"${'x'.repeat(PRESENCE_MAX_MESSAGE_BYTES)}"}`)).toBeNull();
    // Multi-byte characters count by bytes, not string length.
    expect(parseClientMessage(`{"t":"idle","p":"${'é'.repeat(PRESENCE_MAX_MESSAGE_BYTES / 2)}"}`)).toBeNull();
    expect(parseClientMessage(new ArrayBuffer(4))).toBeNull();
    expect(parseClientMessage('not json')).toBeNull();
    expect(parseClientMessage('null')).toBeNull();
    expect(parseClientMessage('{"t":"admin"}')).toBeNull();
  });

  it('subscription toggles only the sub flag', () => {
    const s = applyClientMessage(newSession(identity('a'), T0), { t: 'sub' }, T0);
    expect(s.sub).toBe(true);
    expect(applyClientMessage(s, { t: 'unsub' }, T0).sub).toBe(false);
  });

  it('validates attachments read back after hibernation', () => {
    expect(isSocketSession(live('a', 'reading'))).toBe(true);
    expect(isSocketSession({ ...live('a', 'reading'), cat: 'bogus' })).toBe(false);
    expect(isSocketSession({ k: 'a' })).toBe(false);
    expect(isSocketSession(null)).toBe(false);
  });
});

describe('rate limiting and caps', () => {
  it('allows a short burst, then about one message per 5 s', () => {
    let rate = newSession(identity('a'), T0).rate;
    for (let i = 0; i < RATE_BURST; i += 1) {
      const d = consumeRate(rate, T0);
      expect(d.allowed).toBe(true);
      rate = d.rate;
    }
    const limited = consumeRate(rate, T0);
    expect(limited.allowed).toBe(false);
    expect(limited.rate.strikes).toBe(1);
    expect(consumeRate(limited.rate, T0 + RATE_REFILL_MS).allowed).toBe(true);
  });

  it('asks to close the socket after repeated abuse', () => {
    let rate = { tokens: 0, at: T0, strikes: 0, strikeAt: T0 };
    let close = false;
    for (let i = 0; i < MAX_STRIKES; i += 1) {
      const d = consumeRate(rate, T0 + i);
      rate = d.rate;
      close = d.close;
    }
    expect(close).toBe(true);
  });

  it('enforces per-IP, per-key and total caps', () => {
    expect(withinCaps({ total: 0, perIp: 0, perKey: 0 })).toBe(true);
    expect(withinCaps({ total: 1, perIp: MAX_SOCKETS_PER_IP - 1, perKey: MAX_SOCKETS_PER_KEY - 1 })).toBe(true);
    expect(withinCaps({ total: 1, perIp: MAX_SOCKETS_PER_IP, perKey: 0 })).toBe(false);
    expect(withinCaps({ total: 1, perIp: 0, perKey: MAX_SOCKETS_PER_KEY })).toBe(false);
    expect(withinCaps({ total: MAX_SOCKETS_TOTAL, perIp: 0, perKey: 0 })).toBe(false);
  });
});
