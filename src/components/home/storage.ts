/** localStorage helpers that never throw (private mode, quota, disabled storage). */

export function readStored(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Persistence is a convenience; the UI keeps working in memory.
  }
}

export function removeStored(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore: nothing to clean up when storage is unavailable.
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Storage keys owned by the homepage experience. */
export const STORAGE_KEYS = {
  mascot: 'zuey_mascot_v1',
  mascotHidden: 'zuey_mascot_hidden_v1',
  weather: 'zuey_weather_v1',
  dismissedNotices: 'zuey_notices_dismissed_v1',
  recentCommands: 'zuey_commands_recent_v1',
} as const;
