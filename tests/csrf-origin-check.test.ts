import { describe, expect, it } from 'bun:test';
import { isForbiddenCrossSiteSubmission } from '../src/lib/csrf-origin-check';

const ORIGIN = 'https://zuey.me';

function check(path: string, init: { method?: string; headers?: Record<string, string> }): boolean {
  const url = new URL(path, ORIGIN);
  return isForbiddenCrossSiteSubmission(new Request(url, { method: init.method ?? 'POST', headers: init.headers }), url);
}

describe('cross-site form submission guard', () => {
  it('lets OAuth clients post form bodies to the token and revocation endpoints without an Origin', () => {
    const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
    expect(check('/oauth/token', { headers: form })).toBe(false);
    expect(check('/oauth/revoke', { headers: form })).toBe(false);
    expect(check('/mcp', { method: 'DELETE' })).toBe(false);
  });

  it('refuses cross-site or Origin-less form posts to browser pages', () => {
    expect(check('/oauth/consent', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).toBe(true);
    expect(check('/oauth/consent', { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null' } })).toBe(true);
    expect(check('/oauth/consent', { headers: { 'Content-Type': 'multipart/form-data; boundary=x', Origin: 'https://evil.example' } })).toBe(true);
    expect(check('/api/v1/me', { method: 'DELETE' })).toBe(true);
  });

  it('allows same-origin forms, JSON bodies and safe methods', () => {
    expect(check('/oauth/consent', { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN } })).toBe(false);
    expect(check('/api/webhooks/sepay', { headers: { 'Content-Type': 'application/json' } })).toBe(false);
    expect(check('/oauth/consent', { method: 'GET' })).toBe(false);
  });
});
