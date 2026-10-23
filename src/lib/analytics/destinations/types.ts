/**
 * Destination adapter contracts, implemented by PostHog (`posthog.ts`) and GA4 (`ga4.ts`: gtag in the
 * browser, Measurement Protocol on the server).
 */
import type { AnalyticsProperties } from '../events';

/** Browser-side destination. Every method must be safe to call at any time and never throw. */
export interface ClientDestination {
  readonly name: string;
  /** False while the destination is not loaded on this page (absent: always active). Inactive ones are skipped. */
  active?(): boolean;
  capture(event: string, properties: AnalyticsProperties): void;
  /** Links the current browser to a verified member id (never an email or name). */
  identify(memberId: string): void;
  /** Forgets the identified member and starts a fresh anonymous id. */
  reset(): void;
  optOut(): void;
  optIn(): void;
  /** The id the destination currently attributes events to, or null when unknown. */
  distinctId(): string | null;
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
  /** Whether this destination takes the event (absent: every event). */
  accepts?(event: string): boolean;
  /**
   * Best-effort copy (GA4): sent only after every primary destination accepted the event in the same
   * attempt, and its outcome never decides whether the event is delivered or retried. Absent: primary.
   */
  readonly secondary?: boolean;
  send(event: ServerAnalyticsEvent, signal: AbortSignal): Promise<DestinationResult>;
}
