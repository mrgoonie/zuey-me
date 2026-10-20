import { describe, expect, it } from 'bun:test';
import { changedLabel } from '../src/lib/presence/changed-label';

describe('changedLabel', () => {
  it('is empty when the setting was never saved (epoch)', () => {
    expect(changedLabel(new Date(0).toISOString())).toBe('');
  });
  it('formats a real change time', () => {
    expect(changedLabel('2026-10-20T03:00:00.000Z')).toContain('changed');
  });
  it('falls back to the raw value when unparseable', () => {
    expect(changedLabel('nonsense')).toBe(' · changed nonsense');
  });
});
