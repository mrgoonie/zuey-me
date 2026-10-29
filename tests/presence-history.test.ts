import { describe, expect, test } from 'bun:test';
import { activityHistoryStrings } from '../src/components/activity-monitor/activity-history-i18n';
import { LOCALES } from '../src/lib/i18n/locales';
import {
  PRESENCE_CONTRACT_VERSION, PRESENCE_HISTORY_BUCKETS, PRESENCE_HISTORY_BUCKET_MS, type PresenceHistory, type PresenceHistoryBucket,
} from '../src/lib/presence/contract';
import { isPresenceHistory } from '../src/lib/presence/presence-feed-guards';
import { createHistoryPoller, loadPresenceHistory } from '../src/lib/presence/presence-history';
import { buildHistorySeries, formatHistorySlot, formatHistoryTime, historyTicks } from '../src/lib/presence/presence-history-chart';

const AT = '2026-10-20T04:02:30.000Z'; // inside the 04:00 UTC bucket
const END = Date.parse('2026-10-20T04:00:00.000Z');
const slot = (minutesBeforeEnd: number) => new Date(END - minutesBeforeEnd * 60_000).toISOString();
const history = (buckets: PresenceHistoryBucket[], at = AT): PresenceHistory => ({ v: PRESENCE_CONTRACT_VERSION, at, bucketMinutes: 5, buckets });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('history chart mapping', () => {
  test('always yields the full 24h grid ending at the bucket of `at`, gaps as peak 0', () => {
    const s = buildHistorySeries(history([
      { t: slot(10), peak: 4, categories: [{ id: 'reading', count: 4 }] },
      { t: slot(0), peak: 2, categories: [] },
    ]));
    expect(s.points).toHaveLength(PRESENCE_HISTORY_BUCKETS);
    expect(s.points[s.points.length - 1]).toEqual({ t: END, peak: 2, categories: [], gap: false });
    expect(s.points[0].t).toBe(END - (PRESENCE_HISTORY_BUCKETS - 1) * PRESENCE_HISTORY_BUCKET_MS);
    const ten = s.points[s.points.length - 3];
    expect(ten).toMatchObject({ peak: 4, gap: false, categories: [{ id: 'reading', count: 4 }] });
    const missing = s.points[s.points.length - 2];
    expect(missing).toMatchObject({ peak: 0, gap: true, categories: [] });
    expect(s.points.filter((p) => !p.gap)).toHaveLength(2);
    expect(s).toMatchObject({ max: 4, maxIndex: s.points.length - 3, empty: false });
  });

  test('drops misaligned, out-of-window and unparsable buckets; a duplicate keeps the higher peak', () => {
    const s = buildHistorySeries(history([
      { t: '2026-10-20T03:57:00.000Z', peak: 50, categories: [] }, // not on a 5-minute boundary
      { t: slot(24 * 60), peak: 60, categories: [] }, // one slot older than the window
      { t: '2026-10-20T04:05:00.000Z', peak: 70, categories: [] }, // after `at`
      { t: 'yesterday', peak: 80, categories: [] },
      { t: slot(5), peak: 1, categories: [] },
      { t: slot(5), peak: 3, categories: [] },
    ]));
    expect(s.max).toBe(3);
    expect(s.points.filter((p) => !p.gap).map((p) => p.peak)).toEqual([3]);
  });

  test('all-zero or empty history is the zero state', () => {
    expect(buildHistorySeries(history([])).empty).toBe(true);
    expect(buildHistorySeries(history([{ t: slot(0), peak: 0, categories: [] }]))).toMatchObject({ empty: true, maxIndex: -1, max: 0 });
  });

  test('labels use the viewer time zone (Asia/Saigon is UTC+7) and ticks sit on local 00/06/12/18h', () => {
    expect(formatHistoryTime(END, 'en', 'Asia/Saigon')).toBe('11:00');
    expect(formatHistoryTime(END, 'en', 'UTC')).toBe('04:00');
    expect(formatHistorySlot(END, 'en', 'Asia/Saigon')).toBe('Tue 11:00 – 11:05');
    const s = buildHistorySeries(history([]));
    const saigon = historyTicks(s.points, 'en', 'Asia/Saigon').map((t) => t.label);
    expect(saigon).toEqual(['12:00', '18:00', '00:00', '06:00']);
    const utc = historyTicks(s.points, 'en', 'UTC');
    expect(utc.map((t) => t.label)).toEqual(['06:00', '12:00', '18:00', '00:00']);
    expect(new Date(s.points[utc[0].index].t).toISOString()).toBe('2026-10-19T06:00:00.000Z');
    // A half-hour zone gets its ticks on its own whole hours.
    expect(historyTicks(s.points, 'en', 'Asia/Kolkata').every((t) => new Date(s.points[t.index].t).getUTCMinutes() === 30)).toBe(true);
  });

  test('every locale translates the history strings', () => {
    for (const locale of LOCALES) {
      const t = activityHistoryStrings(locale);
      for (const v of [t.title, t.subtitle, t.loading, t.unavailable, t.empty, t.noBucket, t.keyboardHint, t.breakdown]) expect(v.length).toBeGreaterThan(0);
      expect(t.peak('5')).toContain('5');
      expect(t.chartLabel('9', '10:00')).toContain('9');
    }
  });
});

describe('history guard and loader', () => {
  test('accepts the contract shape and rejects anything else', () => {
    expect(isPresenceHistory(history([{ t: slot(0), peak: 1, categories: [{ id: 'ai', count: 1 }] }]))).toBe(true);
    expect(isPresenceHistory({ ...history([]), v: 2 })).toBe(false);
    expect(isPresenceHistory({ ...history([]), bucketMinutes: 10 })).toBe(false);
    expect(isPresenceHistory(history([{ t: slot(0), peak: -1, categories: [] }]))).toBe(false);
    expect(isPresenceHistory(history([{ t: slot(0), peak: 1.5, categories: [] }]))).toBe(false);
    expect(isPresenceHistory(history([{ t: 'nope', peak: 1, categories: [] }]))).toBe(false);
    expect(isPresenceHistory({ ...history([]), buckets: [{ t: slot(0), peak: 1, categories: [{ id: 'secret-page', count: 1 }] }] })).toBe(false);
    expect(isPresenceHistory([])).toBe(false);
  });

  test('loads from `{origin}/v1/history` and reports failures without throwing', async () => {
    const urls: string[] = [];
    const ok = await loadPresenceHistory('https://presence.test', async (u) => { urls.push(u); return json(history([])); });
    expect(ok.kind).toBe('ok');
    expect(urls).toEqual(['https://presence.test/v1/history']);
    expect(await loadPresenceHistory('o', async () => json({}, 503))).toEqual({ kind: 'failed', error: 'history_503' });
    expect(await loadPresenceHistory('o', async () => json({ v: 1 }))).toEqual({ kind: 'failed', error: 'history_invalid' });
    expect(await loadPresenceHistory('o', async () => { throw new Error('down'); })).toEqual({ kind: 'failed', error: 'history_network' });
    expect(await loadPresenceHistory('o', async () => new Response('<html>'))).toEqual({ kind: 'failed', error: 'history_network' });
  });
});

describe('history poller lifecycle', () => {
  function harness(respond: () => Response) {
    const log: string[] = [];
    let visible = true;
    let calls = 0;
    const poller = createHistoryPoller(
      { onLoading: () => log.push('loading'), onData: () => log.push('data'), onError: (e) => log.push(`error:${e}`) },
      {
        origin: () => 'https://presence.test',
        fetchImpl: async () => { calls++; return respond(); },
        refreshMs: 100,
        retryMs: 20,
        isVisible: () => visible,
      },
    );
    return { poller, log, calls: () => calls, setVisible: (v: boolean) => { visible = v; } };
  }

  test('fetches only after start, refreshes on its interval and stops for good on stop', async () => {
    const h = harness(() => json(history([])));
    await tick(20);
    expect(h.calls()).toBe(0);
    h.poller.start();
    await tick(5);
    expect(h.calls()).toBe(1);
    expect(h.log).toEqual(['loading', 'data']);
    await tick(150);
    expect(h.calls()).toBe(2);
    h.poller.stop();
    await tick(250);
    expect(h.calls()).toBe(2);
  });

  test('a hidden page fetches nothing', async () => {
    const h = harness(() => json(history([])));
    h.setVisible(false);
    h.poller.start();
    await tick(150);
    expect(h.calls()).toBe(0);
    h.poller.stop();
  });

  test('a failure is reported and retried sooner than the refresh', async () => {
    let fail = true;
    const h = harness(() => (fail ? json({}, 503) : json(history([]))));
    h.poller.start();
    await tick(5);
    expect(h.log).toEqual(['loading', 'error:history_503']);
    fail = false;
    await tick(60);
    expect(h.log.slice(2)).toEqual(['loading', 'data']);
    h.poller.stop();
  });

  test('an answer arriving after stop is dropped', async () => {
    let release: (r: Response) => void = () => undefined;
    const log: string[] = [];
    const poller = createHistoryPoller(
      { onLoading: () => log.push('loading'), onData: () => log.push('data'), onError: () => log.push('error') },
      { origin: () => 'o', fetchImpl: () => new Promise<Response>((r) => { release = r; }), isVisible: () => true },
    );
    poller.start();
    await tick(5);
    poller.stop();
    release(json(history([])));
    await tick(5);
    expect(log).toEqual(['loading']);
  });
});
