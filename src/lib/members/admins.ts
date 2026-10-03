import type { RuntimeEnv } from '../../env';

export const DEFAULT_ADMIN_EMAILS = ['goon.nguyen@gmail.com', 'duy@wearetopgroup.com'];

/**
 * Reads ADMIN_EMAILS from the request env, falling back to the Worker's process env
 * (populated under nodejs_compat) for callers that only hold the D1 binding.
 */
function rawAdminEmails(env?: RuntimeEnv): string | undefined {
  if (env?.ADMIN_EMAILS !== undefined) return env.ADMIN_EMAILS;
  return typeof process !== 'undefined' ? process.env.ADMIN_EMAILS : undefined;
}

export function adminEmailList(env?: RuntimeEnv): string[] {
  const raw = rawAdminEmails(env);
  if (raw === undefined || raw.trim() === '') return DEFAULT_ADMIN_EMAILS;
  return raw.split(',').map(e => e.trim().toLowerCase()).filter(e => e.length > 0);
}

/** Admin requires BOTH a verified email and membership in the allowlist. */
export function isAdminIdentity(email: string, emailVerifiedAt: string | null, env?: RuntimeEnv): boolean {
  if (!emailVerifiedAt) return false;
  return adminEmailList(env).includes(email.trim().toLowerCase());
}
