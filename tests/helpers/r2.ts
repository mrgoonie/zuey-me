import type { R2BucketLike, R2ObjectBodyLike } from '../../src/env';

/** In-memory R2 bucket: `objects` exposes what is stored so tests can assert deletions. */
export function createFakeR2(): R2BucketLike & { objects: Map<string, { bytes: Uint8Array; contentType?: string }> } {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  return {
    objects,
    async put(key, value, options) {
      const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value.slice(0));
      objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
      return {};
    },
    async get(key): Promise<R2ObjectBodyLike | null> {
      const o = objects.get(key);
      if (!o) return null;
      return {
        httpMetadata: { contentType: o.contentType },
        async arrayBuffer() {
          return o.bytes.slice().buffer;
        },
      };
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  };
}

/** Smallest byte prefixes the upload validator accepts for each image type. */
export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
