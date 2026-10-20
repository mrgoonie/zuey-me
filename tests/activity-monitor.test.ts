import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { activityMonitorStrings } from '../src/components/activity-monitor/activity-monitor-i18n';
import { AppGlyph } from '../src/components/os/AppGlyph';
import { APPS, APP_IDS, DOCK_APPS, SLOT_APPS } from '../src/components/os/apps';
import { osStrings } from '../src/components/os/os-i18n';
import { LOCALES } from '../src/lib/i18n/locales';
import { ACTIVITY_CATEGORIES } from '../src/lib/presence/contract';

describe('Activity Monitor app registration', () => {
  test('is a shell app on the dock, appended so Alt+1..9 keep their meaning', () => {
    expect(APP_IDS).toContain('activity-monitor');
    expect(APPS['activity-monitor']).toMatchObject({ surface: 'glass', href: '/#activity-monitor' });
    expect((SLOT_APPS as string[]).includes('activity-monitor')).toBe(false);
    expect(DOCK_APPS.slice(0, 12)).toEqual(['about', 'ai', 'knowledges', 'reads', 'zueytube', 'github', 'pricing', 'business', 'mcp', 'account', 'referral', '200lab']);
    expect(DOCK_APPS[DOCK_APPS.length - 1]).toBe('activity-monitor');
  });

  test('has a glyph tile for the dock and the phone home screen', () => {
    const html = renderToStaticMarkup(createElement(AppGlyph, { id: 'activity-monitor' }));
    expect(html).toContain('os-g--activity-monitor');
    expect(html).toContain('<svg');
  });

  test('every locale titles the app and translates every panel string', () => {
    for (const locale of LOCALES) {
      expect(osStrings(locale).apps['activity-monitor'].length).toBeGreaterThan(0);
      const t = activityMonitorStrings(locale);
      for (const cat of ACTIVITY_CATEGORIES) expect(t.categories.names[cat].length).toBeGreaterThan(0);
      for (const text of [t.heading, t.note, t.noData, t.kpi.active, t.kpi.members, t.kpi.membersHidden, t.kpi.owner, t.reason.offline, t.reason.unavailable]) {
        expect(text.length).toBeGreaterThan(0);
      }
      expect(t.updated(12)).toContain('12');
      expect(t.announce(4)).toContain('4');
    }
  });

  test('Vietnamese copy carries full diacritics', () => {
    const vi = activityMonitorStrings('vi');
    expect(vi.kpi.active).toBe('Đang hoạt động');
    expect(vi.kpi.members).toBe('Thành viên');
    expect(vi.kpi.owner).toBe('Zuey (người thật)');
    expect(vi.updated(7)).toBe('cập nhật 7s trước');
    expect(osStrings('vi').apps['activity-monitor']).toBe('Giám sát hoạt động');
  });
});
