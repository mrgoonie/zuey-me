/**
 * Server-side analytics capture. Validates an event against the taxonomy and PII guard, then
 * delivers it to every configured destination with a short timeout. It never throws and never
 * blocks business logic beyond the timeout; callers inspect the returned result (the analytics
 * outbox retries failed deliveries using the same `uuid`).
 */
import {
  ANALYTICS_EVENTS, ANALYTICS_SCHEMA_VERSION, validateEvent,
  type EventProperties, type ServerEventName, type Taxonomy, type ValidationError,
} from './events';
import {
  createPostHogServerDestination, isProductionBuild, isTruthyFlag, resolvePostHogConfig,
  type AnalyticsEnv, type FetchLike,
} from './destinations/posthog';
import { createGa4ServerDestination, resolveGa4ServerConfig } from './destinations/ga4';
import { PRODUCTION_HOSTNAMES } from './constants';
import type { DestinationResult, ServerAnalyticsEvent, ServerDestination } from './destinations/types';
import { isValidDistinctId } from './identity';

export const DEFAULT_SERVER_TIMEOUT_MS = 2500;

export interface ServerDeliveryResult {
  /** True when every primary destination (PostHog) accepted the event; secondary (GA4) results never count. */
  delivered: boolean;
  /** Stable event id; reuse it when retrying so destinations de-duplicate. */
  uuid: string;
  results: DestinationResult[];
  /** Set when the event was rejected before delivery (unknown event/property, PII, bad identity). */
  rejected?: ValidationError | { reason: 'invalid_distinct_id' | 'invalid_uuid' | 'invalid_timestamp' };
}

export interface ServerCaptureOptions {
  timeoutMs?: number;
  /** Reuse an existing id (outbox retry). Defaults to a fresh random UUID. */
  uuid?: string;
  /** When the business fact happened. Defaults to now. */
  occurredAt?: Date | string;
  taxonomy?: Taxonomy;
  /** Hostname of the request that triggers delivery; see `isServerCaptureHost`. */
  requestHost?: string | null;
}

export interface ServerEventInput {
  event: string;
  /** Verified member id, or an anonymous id. Never an email or name. */
  distinctId: string;
  properties?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Server delivery runs only for requests to the production hostnames (`zuey.me`, `www.zuey.me`).
 * Preview deployments (`*.pages.dev`) are production builds with the production PostHog key and share
 * the production database, so the hostname is what keeps them from sending. PUBLIC_ANALYTICS_DEBUG is
 * the explicit override, as in the browser.
 */
export function isServerCaptureHost(env: AnalyticsEnv, requestHost: string | null | undefined): boolean {
  if (isTruthyFlag(env.PUBLIC_ANALYTICS_DEBUG)) return true;
  return typeof requestHost === 'string' && PRODUCTION_HOSTNAMES.includes(requestHost.toLowerCase());
}

/**
 * Destinations configured for this environment and request host. Development and test runs send
 * nothing unless PUBLIC_ANALYTICS_DEBUG is set, and other hosts than production send nothing.
 */
export function serverDestinations(
  env: AnalyticsEnv,
  options: { requestHost: string | null; production?: boolean; fetchImpl?: FetchLike },
): ServerDestination[] {
  if (!isServerCaptureHost(env, options.requestHost)) return [];
  const production = options.production ?? isProductionBuild();
  const debug = isTruthyFlag(env.PUBLIC_ANALYTICS_DEBUG);
  if (!production && !debug) return [];
  // PostHog is the primary destination: without it nothing is sent (the outbox keeps rows queued and the
  // drain reports analytics disabled), even when GA4 is configured.
  const config = resolvePostHogConfig(env, { production });
  if (!config) return [];
  const destinations: ServerDestination[] = [createPostHogServerDestination(config, options.fetchImpl)];
  // GA4 Measurement Protocol (purchase and refund only, best effort) needs the server-only GA4_API_SECRET.
  const ga4 = resolveGa4ServerConfig(env);
  if (ga4) destinations.push(createGa4ServerDestination(ga4, options.fetchImpl));
  return destinations;
}

async function deliver(destination: ServerDestination, event: ServerAnalyticsEvent, timeoutMs: number): Promise<DestinationResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DestinationResult>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ destination: destination.name, ok: false, reason: 'timeout' });
    }, timeoutMs);
  });
  try {
    const sent = destination.send(event, controller.signal).catch((err: unknown): DestinationResult => ({
      destination: destination.name, ok: false, reason: 'network', message: err instanceof Error ? err.message : 'unknown',
    }));
    return await Promise.race([sent, timeout]);
  } catch (err) {
    return { destination: destination.name, ok: false, reason: 'network', message: err instanceof Error ? err.message : 'unknown' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function resolveTimestamp(value: Date | string | undefined): string | null {
  const date = value === undefined ? new Date() : value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Validates and delivers an event given by name (used by the outbox, which stores names as text).
 * Prefer `captureServerEvent` in application code for compile-time property checking.
 */
export async function sendServerEvent(
  input: ServerEventInput,
  destinations: ServerDestination[],
  options: ServerCaptureOptions = {},
): Promise<ServerDeliveryResult> {
  let uuid = options.uuid ?? '';
  try {
    if (!uuid) uuid = crypto.randomUUID();
    if (!UUID_RE.test(uuid)) return { delivered: false, uuid, results: [], rejected: { reason: 'invalid_uuid' } };
    if (!isValidDistinctId(input.distinctId)) return { delivered: false, uuid, results: [], rejected: { reason: 'invalid_distinct_id' } };
    const occurredAt = resolveTimestamp(options.occurredAt);
    if (!occurredAt) return { delivered: false, uuid, results: [], rejected: { reason: 'invalid_timestamp' } };
    const checked = validateEvent(input.event, input.properties, 'server', options.taxonomy ?? ANALYTICS_EVENTS);
    if (!checked.ok) return { delivered: false, uuid, results: [], rejected: checked.error };
    if (destinations.length === 0) {
      return { delivered: false, uuid, results: [{ destination: 'none', ok: false, reason: 'disabled' }] };
    }
    const event: ServerAnalyticsEvent = {
      uuid,
      event: input.event,
      distinctId: input.distinctId,
      occurredAt,
      properties: { ...checked.properties, event_version: checked.version, schema_version: ANALYTICS_SCHEMA_VERSION },
    };
    // A destination that does not take this event (GA4 takes only purchase and refund) is not sent it.
    const targets = destinations.filter(d => d.accepts?.(input.event) ?? true);
    const primaries = targets.filter(d => !d.secondary);
    // Delivery is decided by the primary destinations alone: without one the event is not delivered.
    if (primaries.length === 0) {
      return { delivered: false, uuid, results: [{ destination: 'none', ok: false, reason: 'disabled' }] };
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_SERVER_TIMEOUT_MS;
    const primaryResults = await Promise.all(primaries.map(d => deliver(d, event, timeoutMs)));
    const delivered = primaryResults.every(r => r.ok);
    if (!delivered) return { delivered, uuid, results: primaryResults };
    // Secondary copies go out once, after the primaries accepted: a retried event never reaches them twice,
    // and their failures are reported but never make the event fail or retry.
    const secondaries = targets.filter(d => d.secondary);
    const secondaryResults = await Promise.all(secondaries.map(d => deliver(d, event, timeoutMs)));
    return { delivered, uuid, results: [...primaryResults, ...secondaryResults] };
  } catch (err) {
    return {
      delivered: false, uuid,
      results: [{ destination: 'all', ok: false, reason: 'network', message: err instanceof Error ? err.message : 'unknown' }],
    };
  }
}

/**
 * Typed, immediate server capture for events whose taxonomy source is `server`. Business events that
 * must not be lost go through the outbox (`enqueueServerEvent`) instead.
 */
export async function captureServerEvent<E extends ServerEventName>(
  env: AnalyticsEnv,
  event: E,
  distinctId: string,
  properties: EventProperties<E>,
  options: ServerCaptureOptions = {},
): Promise<ServerDeliveryResult> {
  try {
    return await sendServerEvent({ event, distinctId, properties }, serverDestinations(env, { requestHost: options.requestHost ?? null }), options);
  } catch (err) {
    return {
      delivered: false, uuid: options.uuid ?? '',
      results: [{ destination: 'all', ok: false, reason: 'invalid', message: err instanceof Error ? err.message : 'unknown' }],
    };
  }
}
