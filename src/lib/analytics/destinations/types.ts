/**
 * Destination adapter contracts. PostHog is the only destination today; GA4 (gtag in the browser,
 * Measurement Protocol on the server) plugs in by implementing the same interfaces.
 */
import type { AnalyticsProperties } from '../events';

/** Browser-side destination. Every method must be safe to call at any time and never throw. */
export interface ClientDestination {
  readonly name: string;
  capture(event: string, properties: AnalyticsProperties): void;
  /** Links the current browser to a verified member id (never an email or name). */
  identify(memberId: string): void;
  /** Forgets the identified member and starts a fresh anonymous id. */
  reset(): void;
  optOut(): void;
  optIn(): void;
}

/** A validated server event, ready for delivery. `uuid` lets destinations de-duplicate retries. */
export interface ServerAnalyticsEvent {
  uuid: string;
  event: string;
  distinctId: string;
  properties: AnalyticsProperties;
  /** ISO 8601 UTC time the business fact happened (not the delivery time). */
  occurredAt: string;
}

export type DeliveryFailure = 'disabled' | 'invalid' | 'timeout' | 'network' | 'http';

export type DestinationResult =
  | { destination: string; ok: true; status: number }
  | { destination: string; ok: false; reason: DeliveryFailure; status?: number; message?: string };

/** Server-side destination. `send` must resolve (never reject) and honour `signal`. */
export interface ServerDestination {
  readonly name: string;
  send(event: ServerAnalyticsEvent, signal: AbortSignal): Promise<DestinationResult>;
}
