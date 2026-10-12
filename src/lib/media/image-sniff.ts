/**
 * Identifies an uploaded image from its bytes (never the declared Content-Type) and reads its pixel size
 * from the header. Only raster formats browsers render in <img> are accepted; SVG is refused because it
 * can carry script.
 */

import { LIMITS } from '../blocks/schema';

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/avif';

export interface SniffedImage {
  mime: ImageMime;
  ext: 'png' | 'jpg' | 'gif' | 'webp' | 'avif';
  width: number | null;
  height: number | null;
}

function ascii(b: Uint8Array, start: number, len: number): string {
  return String.fromCharCode(...b.subarray(start, start + len));
}

function be16(b: Uint8Array, i: number): number { return (b[i] << 8) | b[i + 1]; }
function be32(b: Uint8Array, i: number): number { return ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]; }
function le16(b: Uint8Array, i: number): number { return b[i] | (b[i + 1] << 8); }
function le24(b: Uint8Array, i: number): number { return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16); }

/** Positive size the image block accepts, or null (an unreadable or implausible header never blocks the upload). */
function size(width: number, height: number): { width: number | null; height: number | null } {
  const ok = (n: number) => n > 0 && n <= LIMITS.imagePixels;
  return ok(width) && ok(height) ? { width, height } : { width: null, height: null };
}

function jpegSize(b: Uint8Array): { width: number | null; height: number | null } {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return size(be16(b, i + 7), be16(b, i + 5));
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    i += 2 + be16(b, i + 2);
  }
  return { width: null, height: null };
}

function webpSize(b: Uint8Array): { width: number | null; height: number | null } {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ' && b.length >= 30) return size(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
  if (chunk === 'VP8L' && b.length >= 25) {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8X' && b.length >= 30) return size(le24(b, 24) + 1, le24(b, 27) + 1);
  return { width: null, height: null };
}

/**
 * AVIF keeps sizes in `ispe` property boxes: version/flags (4 bytes), then width and height. Thumbnails,
 * alpha planes and grid tiles carry their own, so the largest one is the displayed image.
 */
function avifSize(b: Uint8Array): { width: number | null; height: number | null } {
  // Each box needs 16 bytes from its type field: 'ispe', version/flags, width, height.
  const last = Math.min(b.length - 16, 64 * 1024);
  let best = { width: 0, height: 0 };
  for (let i = 4; i <= last; i++) {
    if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) {
      const width = be32(b, i + 8), height = be32(b, i + 12);
      if (width * height > best.width * best.height) best = { width, height };
    }
  }
  return size(best.width, best.height);
}

/** True when the `ftyp` box names AVIF as its major brand or as one of its compatible brands. */
function isAvif(b: Uint8Array): boolean {
  const boxEnd = Math.min(be32(b, 0), b.length, 256);
  for (let i = 8; i + 4 <= boxEnd; i += 4) {
    if (i === 12) continue; // minor version, not a brand
    const brand = ascii(b, i, 4);
    if (brand === 'avif' || brand === 'avis') return true;
  }
  return false;
}

/** Returns the detected image type and size, or null when the bytes are not a supported image. */
export function sniffImage(b: Uint8Array): SniffedImage | null {
  if (b.length < 16) return null;
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b.length >= 24) {
    return { mime: 'image/png', ext: 'png', ...size(be32(b, 16), be32(b, 20)) };
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg', ...jpegSize(b) };
  const head6 = ascii(b, 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return { mime: 'image/gif', ext: 'gif', ...size(le16(b, 6), le16(b, 8)) };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return { mime: 'image/webp', ext: 'webp', ...webpSize(b) };
  if (ascii(b, 4, 4) === 'ftyp' && isAvif(b)) return { mime: 'image/avif', ext: 'avif', ...avifSize(b) };
  return null;
}
