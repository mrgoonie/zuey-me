/**
 * Identity lifecycle rules. A browser is linked to at most one verified member at a time: signing in
 * links the anonymous history to that member, signing out (or the session ending elsewhere) resets to
 * a fresh anonymous id, and a different member signing in on the same device starts from a reset so
 * two people are never merged.
 */
import { containsPii } from './pii';

/** localStorage key holding the member id this browser is currently identified as. */
export const IDENTITY_STORAGE_KEY = 'zuey_analytics_member';
/** sessionStorage key caching the server's answer to "who is signed in" for this tab. */
export const IDENTITY_CACHE_KEY = 'zuey_analytics_identity';
export const IDENTITY_CACHE_TTL_MS = 10 * 60 * 1000;
/** Same-origin endpoint returning `{ member_id }` for the session cookie (never email or name). */
export const IDENTITY_ENDPOINT = '/api/members/auth/identity';

const DISTINCT_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

/** A distinct id is an opaque member/anonymous id: no `@`, spaces, JWTs or secret tokens. */
export function isValidDistinctId(id: string): boolean {
  return DISTINCT_ID_RE.test(id) && !containsPii(id);
}

export type IdentityStep = 'reset' | 'identify';

/** Steps that move the browser from the previously identified member to the current one. */
export function planIdentity(previous: string | null, current: string | null): IdentityStep[] {
  if (previous === current) return [];
  if (current === null) return ['reset'];
  if (previous === null) return ['identify'];
  return ['reset', 'identify'];
}

/** Pages where the signed-in member may just have changed; the tab cache is bypassed there. */
const AUTH_PATH_RE = /^\/(?:login|account|oauth)(?:\/|$)/;

export function isAuthPath(pathname: string): boolean {
  return AUTH_PATH_RE.test(pathname);
}

export interface IdentityCacheEntry {
  memberId: string | null;
  at: number;
}

export function parseIdentityCache(raw: string | null, now: number): IdentityCacheEntry | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const memberId = 'memberId' in parsed ? parsed.memberId : undefined;
    const at = 'at' in parsed ? parsed.at : undefined;
    if (typeof at !== 'number' || now - at > IDENTITY_CACHE_TTL_MS || now < at) return null;
    if (memberId !== null && typeof memberId !== 'string') return null;
    return { memberId, at };
  } catch {
    return null;
  }
}

/** Extracts `data.member_id` from the identity endpoint envelope; undefined when the shape is wrong. */
export function parseIdentityResponse(body: unknown): string | null | undefined {
  if (typeof body !== 'object' || body === null || !('data' in body)) return undefined;
  const data = body.data;
  if (typeof data !== 'object' || data === null || !('member_id' in data)) return undefined;
  const id = data.member_id;
  if (id === null) return null;
  return typeof id === 'string' ? id : undefined;
}
