import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestD1 } from './helpers/d1';
import type { D1DatabaseLike } from '../src/db/store';
import { AppError } from '../src/lib/http';
import { iso, membersRuntime } from '../src/lib/members/runtime';
import { createMemberSession } from '../src/lib/members/session';
import { deleteAccount, findOrCreateVerifiedUser, getUserById } from '../src/lib/members/users';

const T0 = Date.parse('2026-10-11T03:00:00.000Z');
const HOUR = 60 * 60 * 1000;
let d1: ReturnType<typeof createTestD1>;

beforeEach(() => {
  d1 = createTestD1();
  membersRuntime.now = () => T0;
});

afterEach(() => {
  membersRuntime.now = () => Date.now();
});

async function seedMember(): Promise<string> {
  const { user } = await findOrCreateVerifiedUser(d1, { email: 'alice@example.com', name: 'Alice' });
  await createMemberSession(d1, user.id);
  d1.raw.run("INSERT INTO user_identities (id, user_id, provider, subject, email, created_at) VALUES ('uid_1', ?, 'google', 'g-123', 'alice@example.com', ?)", [user.id, iso(T0)]);
  d1.raw.run("INSERT INTO channel_identities (provider, external_id, user_id, linked_at, source) VALUES ('telegram', '777001', ?, ?, 'link_token')", [user.id, iso(T0)]);
  d1.raw.run("INSERT INTO channel_link_nonces (nonce, provider, external_id, user_id, used_at, expires_at) VALUES ('nonce-live', 'telegram', '777001', ?, ?, ?)",
    [user.id, iso(T0), iso(T0 + HOUR)]);
  return user.id;
}

/** Personal data still tied to the member, as one comparable snapshot. */
function personalData(userId: string): Record<string, unknown> {
  const count = (sql: string): number => (d1.raw.query(sql).get(userId) as { n: number }).n;
  return {
    user: d1.raw.query('SELECT email, name, deleted_at FROM users WHERE id = ?').get(userId),
    sessions: count('SELECT COUNT(*) AS n FROM member_sessions WHERE user_id = ?'),
    identities: count('SELECT COUNT(*) AS n FROM user_identities WHERE user_id = ?'),
    channels: count('SELECT COUNT(*) AS n FROM channel_identities WHERE user_id = ?'),
    nonces: count('SELECT COUNT(*) AS n FROM channel_link_nonces WHERE user_id = ?'),
  };
}

describe('account deletion atomicity', () => {
  it('leaves nothing half-deleted when a statement fails, and a retry completes the deletion', async () => {
    const userId = await seedMember();
    const before = personalData(userId);
    expect(before).toMatchObject({ user: { email: 'alice@example.com', name: 'Alice', deleted_at: null }, sessions: 1, identities: 1, channels: 1, nonces: 1 });

    // Same database, but the last statement of the batch violates the users primary key, after every
    // cleanup statement has already run inside the transaction.
    const failing: D1DatabaseLike = {
      prepare: sql => d1.prepare(sql),
      batch: statements => d1.batch([
        ...statements,
        d1.prepare("INSERT INTO users (id, email, locale, created_at, updated_at) VALUES (?, 'dup@example.com', 'vi', ?, ?)").bind(userId, iso(T0), iso(T0)),
      ]),
    };
    const user = await getUserById(d1, userId);
    if (!user) throw new Error('missing user');
    await expect(deleteAccount(failing, user)).rejects.toThrow();
    expect(personalData(userId)).toEqual(before);

    await deleteAccount(d1, user);
    expect(personalData(userId)).toMatchObject({
      user: { email: `deleted+${userId}@deleted.invalid`, name: null, deleted_at: iso(T0) },
      sessions: 0, identities: 0, channels: 0, nonces: 0,
    });

    // Deleting again is still a 404 and changes nothing.
    const after = personalData(userId);
    const again = await deleteAccount(d1, user).then(() => null, (e: unknown) => e);
    expect(again).toBeInstanceOf(AppError);
    expect(again instanceof AppError ? again.status : 0).toBe(404);
    expect(personalData(userId)).toEqual(after);
  });
});

describe('GA4 ids on account deletion', () => {
  const GA = { ga_client_id: '1234567890.1700000000', ga_session_id: '1700000500' };

  function queueRow(id: string, distinctId: string, event: string, status: string, properties: unknown): void {
    d1.raw.run(
      `INSERT INTO analytics_outbox (id, dedupe_key, event, distinct_id, properties, occurred_at, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [id, `k:${id}`, event, distinctId, typeof properties === 'string' ? properties : JSON.stringify(properties), iso(T0), status, iso(T0), iso(T0), iso(T0)],
    );
  }
  const props = (id: string): string => (d1.raw.query('SELECT properties FROM analytics_outbox WHERE id = ?').get(id) as { properties: string }).properties;

  it('deletes the account even when the GA4 clients table does not exist', async () => {
    const userId = await seedMember();
    d1.raw.run('DROP TABLE analytics_ga4_clients');
    const user = await getUserById(d1, userId);
    if (!user) throw new Error('missing user');
    await deleteAccount(d1, user);
    expect(personalData(userId)).toMatchObject({ user: { deleted_at: iso(T0), name: null }, sessions: 0, identities: 0, channels: 0 });
  });

  it("removes the member's stored GA ids and their copies in queued events, and nobody else's", async () => {
    const userId = await seedMember();
    for (const [uid, client] of [[userId, '1.1'], ['usr_other', '2.2']]) {
      d1.raw.run('INSERT INTO analytics_ga4_clients (user_id, client_id, session_id, updated_at) VALUES (?, ?, ?, ?)', [uid, client, '3', iso(T0)]);
    }
    const purchase = { provider: 'sepay', order_type: 'membership', amount: 1, currency: 'VND', renewal: false, ...GA };
    queueRow('p1', userId, 'purchase', 'pending', purchase);
    queueRow('r1', userId, 'refund', 'dead', { provider: 'sepay', order_type: 'membership', reason: 'refund', ga_client_id: GA.ga_client_id });
    queueRow('p2', 'usr_other', 'purchase', 'pending', purchase);
    queueRow('bad', userId, 'purchase', 'pending', '{not json');
    const user = await getUserById(d1, userId);
    if (!user) throw new Error('missing user');
    await deleteAccount(d1, user);

    const left = d1.raw.query('SELECT user_id FROM analytics_ga4_clients').all() as Array<{ user_id: string }>;
    expect(left.map(r => r.user_id)).toEqual(['usr_other']);
    expect(JSON.parse(props('p1'))).toEqual({ provider: 'sepay', order_type: 'membership', amount: 1, currency: 'VND', renewal: false });
    expect(JSON.parse(props('r1'))).toEqual({ provider: 'sepay', order_type: 'membership', reason: 'refund' });
    expect(JSON.parse(props('p2'))).toMatchObject(GA);
    expect(props('bad')).toBe('{not json');
    expect(personalData(userId)).toMatchObject({ user: { deleted_at: iso(T0) } });
  });
});
