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
  createPostHogServerDestination, isProductionBuild, resolvePostHogConfig,
  type AnalyticsEnv, type FetchLike,
} from './destinations/posthog';
import type { DestinationResult, ServerAnalyticsEvent, ServerDestination } from './destinations/types';
import { isValidDistinctId } from './identity';

export const DEFAULT_SERVER_TIMEOUT_MS = 2500;

export interface ServerDeliveryResult {
  /** True when at least one destination accepted the event. */
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
}

export interface ServerEventInput {
  event: string;
  /** Verified member id, or an anonymous id. Never an email or name. */
  distinctId: string;
  properties?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Destinations configured for this environment. Development and test runs send nothing unless
 * PUBLIC_ANALYTICS_DEBUG is set, mirroring the browser.
 */
export function serverDestinations(
  env: AnalyticsEnv,
  options: { production?: boolean; fetchImpl?: FetchLike } = {},
): ServerDestination[] {
  const production = options.production ?? isProductionBuild();
  const config = resolvePostHogConfig(env, { production });
  if (!config || (!production && !config.debug)) return [];
  return [createPostHogServerDestination(config, options.fetchImpl)];
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
    const timeoutMs = options.timeoutMs ?? DEFAULT_SERVER_TIMEOUT_MS;
    const results = await Promise.all(destinations.map(d => deliver(d, event, timeoutMs)));
    return { delivered: results.some(r => r.ok), uuid, results };
  } catch (err) {
    return {
      delivered: false, uuid,
      results: [{ destination: 'all', ok: false, reason: 'network', message: err instanceof Error ? err.message : 'unknown' }],
    };
  }
}

/** Typed server capture for events whose taxonomy source is `server`. */
export async function captureServerEvent<E extends ServerEventName>(
  env: AnalyticsEnv,
  event: E,
  distinctId: string,
  properties: EventProperties<E>,
  options: ServerCaptureOptions = {},
): Promise<ServerDeliveryResult> {
  try {
    return await sendServerEvent({ event, distinctId, properties }, serverDestinations(env), options);
  } catch (err) {
    return {
      delivered: false, uuid: options.uuid ?? '',
      results: [{ destination: 'all', ok: false, reason: 'invalid', message: err instanceof Error ? err.message : 'unknown' }],
    };
  }
}
