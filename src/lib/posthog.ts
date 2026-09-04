export interface PostHogInstance {
  capture(event: string, properties?: Record<string, unknown>): void;
}

export function getPostHog(): PostHogInstance | null {
  if (typeof window === 'undefined') return null;
  const globalWin: unknown = window;
  if (globalWin && typeof globalWin === 'object' && 'posthog' in globalWin) {
    const ph = (globalWin as Record<string, unknown>).posthog;
    if (ph && typeof ph === 'object' && 'capture' in ph && typeof (ph as Record<string, unknown>).capture === 'function') {
      return ph as PostHogInstance;
    }
  }
  return null;
}

export function trackEvent(event: string, properties?: Record<string, unknown>): void {
  const ph = getPostHog();
  if (ph) {
    ph.capture(event, properties);
  }
}
