/**
 * Typed analytics event taxonomy: the single source of truth for every event zuey.me sends to an
 * analytics destination. An event that is not listed here, or a property that is not declared for
 * its event, is rejected before it leaves the app. `docs/analytics-events.md` documents each entry.
 */
import { containsPii, scrubUrl } from './pii';

/** Bumped when the meaning of the shared envelope (not a single event) changes. */
export const ANALYTICS_SCHEMA_VERSION = 1;

/** Where an event is emitted: the browser (`track()`) or the server (`sendServerEvent()`). */
export type EventSource = 'client' | 'server';

/**
 * Property kinds. `url` values are scrubbed of sensitive query parameters instead of rejected;
 * every string value is rejected when it looks like an email, JWT or secret token.
 */
export type PropKind = 'string' | 'number' | 'boolean' | 'url';

export interface PropSpec {
  readonly kind: PropKind;
  readonly optional?: boolean;
}

export interface EventSpec {
  /** Version of this event's property contract; bump when a property changes meaning. */
  readonly version: number;
  readonly source: EventSource;
  readonly owner: string;
  readonly trigger: string;
  readonly props: Readonly<Record<string, PropSpec>>;
}

export type Taxonomy = Readonly<Record<string, EventSpec>>;

const str = { kind: 'string' } as const;
const num = { kind: 'number' } as const;
const bool = { kind: 'boolean' } as const;
const url = { kind: 'url' } as const;

export const ANALYTICS_EVENTS = {
  link_clicked: {
    version: 1, source: 'client', owner: 'growth', trigger: 'A profile link card is opened',
    props: { id: str, section: str, title: str, url },
  },
  social_clicked: {
    version: 1, source: 'client', owner: 'growth', trigger: 'A social icon on the profile is clicked',
    props: { platform: str },
  },
  explore_clicked: {
    version: 1, source: 'client', owner: 'growth', trigger: 'An explore shortcut on the profile is clicked',
    props: { target: url },
  },
  language_changed: {
    version: 1, source: 'client', owner: 'growth', trigger: 'The visitor picks another locale in the language switch',
    props: { language: str },
  },
  command_palette_action: {
    version: 1, source: 'client', owner: 'product', trigger: 'An action is run from the command palette',
    props: { action: str },
  },
  command_palette_article: {
    version: 1, source: 'client', owner: 'product', trigger: 'An article result is opened from the command palette',
    props: { slug: str },
  },
  command_palette_video: {
    version: 1, source: 'client', owner: 'product', trigger: 'A video result is opened from the command palette',
    props: { youtube_id: str },
  },
  '200lab_course_click': {
    version: 1, source: 'client', owner: 'growth', trigger: 'A 200lab course card (affiliate) is clicked',
    props: { slug: str, source: str },
  },
  article_ask_ai_opened: {
    version: 1, source: 'client', owner: 'product', trigger: 'The Ask Zuey AI button of an article is pressed',
    props: { slug: str },
  },
  article_ask_ai_clicked: {
    version: 1, source: 'client', owner: 'product', trigger: 'Ask AI is pressed on a text selection in an article',
    props: { slug: str, chars: num },
  },
  article_ask_ai_sent: {
    version: 1, source: 'client', owner: 'product', trigger: 'A question started from an article is sent to Zuey AI',
    props: { slug: str, quoted: bool },
  },
} as const satisfies Taxonomy;

type Events = typeof ANALYTICS_EVENTS;
export type EventName = keyof Events;
export type ClientEventName = { [K in EventName]: Events[K]['source'] extends 'client' ? K : never }[EventName];
export type ServerEventName = { [K in EventName]: Events[K]['source'] extends 'server' ? K : never }[EventName];

type KindType<K extends PropKind> = K extends 'number' ? number : K extends 'boolean' ? boolean : string;
type PropsOf<S extends Readonly<Record<string, PropSpec>>> =
  { [P in keyof S as S[P] extends { optional: true } ? never : P]: KindType<S[P]['kind']> } &
  { [P in keyof S as S[P] extends { optional: true } ? P : never]?: KindType<S[P]['kind']> };

/** Exact property bag accepted for an event. */
export type EventProperties<E extends EventName> = PropsOf<Events[E]['props']>;

export type AnalyticsProperties = Record<string, string | number | boolean>;

export type ValidationError =
  | { reason: 'unknown_event'; event: string }
  | { reason: 'wrong_source'; event: string }
  | { reason: 'unknown_property' | 'missing_property' | 'invalid_type' | 'pii' | 'too_long'; event: string; property: string };

export type ValidationResult =
  | { ok: true; properties: AnalyticsProperties; version: number }
  | { ok: false; error: ValidationError };

/** Longest string a property may carry; longer values are free text (chat, prompts) and are rejected. */
export const MAX_STRING_LENGTH = 500;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates an event against the taxonomy: the event must exist and come from `source`, every
 * property must be declared with the right kind, and no string may look like personal data.
 * Returns a fresh, scrubbed property bag; the input is never mutated.
 */
export function validateEvent(
  event: string,
  properties: unknown,
  source: EventSource,
  taxonomy: Taxonomy = ANALYTICS_EVENTS,
): ValidationResult {
  const spec = Object.prototype.hasOwnProperty.call(taxonomy, event) ? taxonomy[event] : undefined;
  if (!spec) return { ok: false, error: { reason: 'unknown_event', event } };
  if (spec.source !== source) return { ok: false, error: { reason: 'wrong_source', event } };
  const input = properties === undefined ? {} : properties;
  if (!isPlainRecord(input)) return { ok: false, error: { reason: 'invalid_type', event, property: '*' } };

  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(spec.props, key)) {
      return { ok: false, error: { reason: 'unknown_property', event, property: key } };
    }
  }

  const out: AnalyticsProperties = {};
  for (const [key, prop] of Object.entries(spec.props)) {
    const value = input[key];
    if (value === undefined || value === null) {
      if (prop.optional) continue;
      return { ok: false, error: { reason: 'missing_property', event, property: key } };
    }
    if (prop.kind === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: { reason: 'invalid_type', event, property: key } };
      out[key] = value;
    } else if (prop.kind === 'boolean') {
      if (typeof value !== 'boolean') return { ok: false, error: { reason: 'invalid_type', event, property: key } };
      out[key] = value;
    } else {
      if (typeof value !== 'string') return { ok: false, error: { reason: 'invalid_type', event, property: key } };
      if (value.length > MAX_STRING_LENGTH) return { ok: false, error: { reason: 'too_long', event, property: key } };
      const cleaned = prop.kind === 'url' ? scrubUrl(value) : value;
      if (containsPii(cleaned)) return { ok: false, error: { reason: 'pii', event, property: key } };
      out[key] = cleaned;
    }
  }
  return { ok: true, properties: out, version: spec.version };
}
