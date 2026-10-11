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
