import { useEffect, useRef } from 'react';
import { LIMITS } from '../../lib/blocks/schema';
import type { ImageSize } from '../../lib/blocks/schema';

/** Waits for typing to pause before loading the URL. */
const PROBE_DELAY_MS = 400;

/** True when both sides of the size are recorded. */
export function hasImageSize(size: ImageSize): boolean {
  return Boolean(size.width && size.height);
}

/** The value without its recorded size: a new URL must be measured again. */
export function withoutImageSize<T extends ImageSize>(value: T): Omit<T, 'width' | 'height'> {
  const { width: _w, height: _h, ...rest } = value;
  return rest;
}

interface ImageSizeProbeProps {
  url: string;
  /** The size is already recorded; nothing to measure. */
  known: boolean;
  onSize: (size: { width: number; height: number }) => void;
}

/**
 * Loads an image URL in the background and reports its natural size, so the stored block carries
 * `width`/`height` and readers reserve the image box before it loads. Renders nothing; a URL that fails
 * to load (or reports no size) leaves the block without a size, which still renders.
 * Only a URL entered after the field appears is measured: opening an older article never edits its
 * unsized images by itself (that would mark the draft unsaved and block publishing).
 */
export function ImageSizeProbe({ url, known, onSize }: ImageSizeProbeProps) {
  const latest = useRef(onSize);
  latest.current = onSize;
  const initialUrl = useRef(url);

  useEffect(() => {
    if (known || url === initialUrl.current || !/^https:\/\/[^/]+\/./.test(url)) return;
    let cancelled = false;
    const probe = new Image();
    const timer = setTimeout(() => {
      probe.onload = () => {
        const { naturalWidth: width, naturalHeight: height } = probe;
        const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= LIMITS.imagePixels;
        if (!cancelled && valid(width) && valid(height)) latest.current({ width, height });
      };
      probe.src = url;
    }, PROBE_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); probe.onload = null; };
  }, [url, known]);

  return null;
}
