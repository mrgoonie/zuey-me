import { describe, expect, it } from 'bun:test';
import { fmtChangedAt } from '../src/components/studio/PresenceOwnerPanel';

describe('fmtChangedAt', () => {
  it('returns null for the never-saved epoch default', () => {
    expect(fmtChangedAt(new Date(0).toISOString())).toBeNull();
  });

  it('formats a real save time', () => {
    const out = fmtChangedAt('2026-10-20T01:00:00.000Z');
    expect(out).toContain('2026');
    expect(out).not.toContain('1970');
  });

  it('falls back to the raw value when unparseable', () => {
    expect(fmtChangedAt('not-a-date')).toBe('not-a-date');
  });
});
