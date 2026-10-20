import { describe, expect, it } from 'bun:test';
import { fmtChangedAt } from '../src/components/studio/PresenceOwnerPanel';

describe('fmtChangedAt', () => {
  it('returns null for the never-saved epoch default', () => {
    expect(fmtChangedAt(new Date(0).toISOString())).toBeNull();
  });

  it('formats a real save time', () => {
    const out = fmtChangedAt('2026-10-20T01:00:00.000Z');
    expect(out).toContain('08:00:00');
    expect(out).toContain('20/10/2026');
  });

  it('returns null for times before the epoch', () => {
    expect(fmtChangedAt('1969-12-31T23:59:59.000Z')).toBeNull();
  });

  it('falls back to the raw value when unparseable', () => {
    expect(fmtChangedAt('not-a-date')).toBe('not-a-date');
  });
});
