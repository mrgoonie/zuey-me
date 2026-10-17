/** Deterministic JSON (object keys sorted) so equal data always hashes to the same digest. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

/** Lowercase hex SHA-256 of a string (Web Crypto, edge safe). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Short stable digest of any JSON value, `sha256:` + first 16 hex characters. */
export async function contentHash(value: unknown): Promise<string> {
  return `sha256:${(await sha256Hex(stableStringify(value))).slice(0, 16)}`;
}
