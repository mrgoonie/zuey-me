import { describe, expect, test } from 'bun:test';
import { createAnalyticsClient, type AnalyticsClientDeps } from '../src/lib/analytics/client';
import type { ConsentEnvironment } from '../src/lib/analytics/consent';
import type { ClientDestination } from '../src/lib/analytics/destinations/types';
import {
  ENGAGED_DEPTH, ENGAGED_SECONDS, PERFORMANCE_CAPTURE_OPTIONS, aiFailureLatency, aiReplyMetrics, aiSurface, depthBucket,
  filterValue, isEngaged, publicSlug, scrollDepth, siteDomain,
} from '../src/lib/analytics/engagement';
import { ANALYTICS_EVENTS, validateEvent, type EventSpec } from '../src/lib/analytics/events';
import { createEngagementTracker } from '../src/scripts/article-analytics';

const ENGAGEMENT_EVENTS = [
  'knowledge_search', 'knowledge_filter_applied', 'article_opened', 'article_engaged', 'paywall_viewed', 'article_unlocked',
  'reads_opened', 'read_source_clicked', 'ai_chat_started', 'ai_message_submitted', 'ai_response_completed', 'ai_response_failed',
  'ai_quota_reached', 'app_opened', 'community_invite_requested', 'community_joined', 'survey_submitted', 'feature_error',
] as const;

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
}

function fakeClient(consent: ConsentEnvironment = { navigator: {}, storage: new MemoryStorage() }) {
  const captured: { event: string; props: Record<string, unknown> }[] = [];
  const dest: ClientDestination = {
    name: 'fake',
    capture: (event, props) => { captured.push({ event, props }); },
    identify: () => undefined, reset: () => undefined, optOut: () => undefined, optIn: () => undefined, distinctId: () => null,
  };
  const deps: AnalyticsClientDeps = {
    destinations: [dest],
    consent: () => consent,
    local: () => new MemoryStorage(),
    session: () => new MemoryStorage(),
    fetchIdentity: async () => undefined,
    now: () => 1_000_000,
    debug: () => undefined,
    page: () => ({ search: '', referrer: '', hostname: 'zuey.me' }),
  };
  return { client: createAnalyticsClient(deps), captured };
}

describe('engagement taxonomy', () => {
  test('every engagement event is a client event with plain, non-URL properties and no content fields', () => {
    for (const name of ENGAGEMENT_EVENTS) {
      const spec: EventSpec = ANALYTICS_EVENTS[name];
      expect(spec.source).toBe('client');
      for (const [prop, kind] of Object.entries(spec.props)) {
        expect(kind.kind).not.toBe('url');
        // Never the search text, chat text, vote labels, titles or anything naming a person.
        expect(prop).not.toMatch(/email|phone|name|^token|_token$|url|query$|^q$|text|content|message$|title|label|answer|option_id|_id$|^id$/);
      }
    }
  });

  test('AI metrics come from the backend and stay optional; search sends a length, never the query', () => {
    expect(Object.keys(ANALYTICS_EVENTS.ai_response_completed.props).sort())
      .toEqual(['artifacts', 'completion_tokens', 'cost_cents', 'latency_ms', 'prompt_tokens', 'sources', 'surface']);
    expect(ANALYTICS_EVENTS.knowledge_search.props.query_length.kind).toBe('number');
    const bad: unknown = { surface: 'home', query_length: 5, results: 1, query: 'claude code' };
    expect(validateEvent('knowledge_search', bad, 'client')).toMatchObject({ ok: false, error: { reason: 'unknown_property', property: 'query' } });
    expect(validateEvent('feature_error', { feature: 'survey_vote', reason: 'duy@example.com' }, 'client')).toMatchObject({ ok: false, error: { reason: 'pii' } });
  });
});

describe('engagement helpers', () => {
  test('publicSlug and filterValue keep taxonomy slugs and drop anything else', () => {
    expect(publicSlug('agents')).toBe('agents');
    expect(publicSlug('Claude-Code')).toBe('claude-code');
    expect(publicSlug('freshness:2026-q3')).toBe('freshness:2026-q3');
    for (const bad of ['Nguyễn Văn A', 'duy@example.com', 'https://x.test/a', '0912345678', 'a b', '', null, undefined]) {
      expect(publicSlug(bad)).toBe('other');
    }
    expect(filterValue('')).toBe('all');
    expect(filterValue(null)).toBe('all');
    expect(filterValue('video')).toBe('video');
  });

  test('siteDomain keeps a bare host only', () => {
    expect(siteDomain('www.anthropic.com')).toBe('anthropic.com');
    expect(siteDomain('news.ycombinator.com')).toBe('news.ycombinator.com');
    for (const bad of ['https://a.com/x', 'a.com/path?q=1', 'localhost', 'duy@example.com', null]) expect(siteDomain(bad)).toBe('other');
  });

  test('scroll depth, buckets and the engaged threshold', () => {
    expect(scrollDepth({ top: 800, height: 2000 }, 800)).toBe(0);
    expect(scrollDepth({ top: -200, height: 2000 }, 800)).toBe(50);
    expect(scrollDepth({ top: -5000, height: 2000 }, 800)).toBe(100);
    expect(scrollDepth({ top: 0, height: 0 }, 800)).toBe(100);
    expect([0, 24, 25, 49, 50, 99, 100, 140, Number.NaN].map(depthBucket)).toEqual([0, 0, 25, 25, 50, 75, 100, 100, 0]);
    expect(isEngaged(ENGAGED_SECONDS, ENGAGED_DEPTH)).toBe(true);
    expect(isEngaged(ENGAGED_SECONDS - 1, 100)).toBe(false);
    expect(isEngaged(600, ENGAGED_DEPTH - 1)).toBe(false);
  });

  test('the engagement tracker fires once, only after both visible time and depth are reached', () => {
    const fired: [number, number][] = [];
    const tracker = createEngagementTracker((s, d) => fired.push([s, d]));
    for (let i = 0; i < ENGAGED_SECONDS + 5; i += 1) tracker.tick();
    expect(fired).toEqual([]);
    tracker.observeDepth(30);
    expect(fired).toEqual([]);
    tracker.observeDepth(68);
    tracker.observeDepth(20);
    for (let i = 0; i < 10; i += 1) tracker.tick();
    expect(fired).toEqual([[ENGAGED_SECONDS + 5, 50]]);
    expect(tracker.done).toBe(true);
  });

  test('AI surface and backend metrics', () => {
    expect(aiSurface(true, '/chat')).toBe('article');
    expect(aiSurface(false, '/chat/')).toBe('chat_page');
    expect(aiSurface(false, '/')).toBe('window');
    expect(aiReplyMetrics({ latency_ms: 1234.6, cost_cents: 0.42, usage: { prompt_tokens: 1000, completion_tokens: 50 }, content: 'secret answer' }))
      .toEqual({ latency_ms: 1235, cost_cents: 0.42, prompt_tokens: 1000, completion_tokens: 50 });
    expect(aiReplyMetrics({ usage: null, latency_ms: -1, cost_cents: 'x' })).toEqual({});
    expect(aiFailureLatency({ latency_ms: 250 })).toEqual({ latency_ms: 250 });
    expect(aiFailureLatency({})).toEqual({});
  });

  test('Web Vitals and exception autocapture are enabled, network timing is not', () => {
    expect(PERFORMANCE_CAPTURE_OPTIONS.capture_performance).toEqual({ web_vitals: true, network_timing: false });
    expect(PERFORMANCE_CAPTURE_OPTIONS.capture_exceptions).toMatchObject({ capture_unhandled_errors: true, capture_unhandled_rejections: true });
  });
});

describe('consent', () => {
  test('Do Not Track, Global Privacy Control and an opt-out drop every engagement event', () => {
    const send = (client: ReturnType<typeof fakeClient>['client']) => {
      client.track('knowledge_search', { surface: 'home', query_length: 4, results: 2 });
      client.track('app_opened', { app: 'ai', already_open: false });
      client.trackOnce('article_opened', 'article_opened', { slug: 'a', locale: 'vi', access: 'free', locked: false, reading_minutes: 3 });
      client.track('ai_response_completed', { surface: 'window', sources: 1, artifacts: 0, latency_ms: 900 });
    };
    for (const consent of [
      { navigator: { doNotTrack: '1' }, storage: new MemoryStorage() },
      { navigator: { globalPrivacyControl: true }, storage: new MemoryStorage() },
    ]) {
      const { client, captured } = fakeClient(consent);
      client.activate(false);
      send(client);
      expect(captured).toEqual([]);
    }
    const opted = fakeClient();
    opted.client.activate(false);
    opted.client.optOut();
    send(opted.client);
    expect(opted.captured).toEqual([]);

    const allowed = fakeClient();
    allowed.client.activate(false);
    send(allowed.client);
    expect(allowed.captured.map(c => c.event)).toEqual(['knowledge_search', 'app_opened', 'article_opened', 'ai_response_completed']);
  });
});
