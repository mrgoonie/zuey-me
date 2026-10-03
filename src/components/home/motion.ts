import { useEffect, useState } from 'react';

type Gsap = typeof import('gsap').gsap;

let gsapPromise: Promise<Gsap | null> | null = null;

/** Lazily loads GSAP on the client only; resolves null on the server or if the chunk fails. */
export function loadGsap(): Promise<Gsap | null> {
  if (import.meta.env.SSR) return Promise.resolve(null);
  gsapPromise ??= import('gsap')
    .then(mod => mod.gsap)
    .catch(() => null);
  return gsapPromise;
}

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_QUERY).matches;
}

/** Live `prefers-reduced-motion` flag (false during SSR). */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(REDUCED_QUERY);
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** Live media-query flag (false during SSR). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Dialog entrance: a short scale/fade with GSAP, or nothing under reduced motion. */
export async function animateDialogIn(el: HTMLElement | null): Promise<void> {
  if (!el || prefersReducedMotion()) return;
  const gsap = await loadGsap();
  if (!gsap) return;
  gsap.fromTo(el, { opacity: 0, y: 12, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.28, ease: 'power3.out', clearProps: 'transform,opacity' });
}
