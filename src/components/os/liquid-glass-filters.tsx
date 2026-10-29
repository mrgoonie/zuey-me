import React, { useEffect, useLayoutEffect, useState } from 'react';
import { useMediaQuery } from '../home/motion';
import { GLASS_LENSES, GLASS_QUERIES, displacementMap, glassTier, readEngineCapabilities, type GlassCapabilities, type GlassLens, type GlassTier } from './liquid-glass';

const Lens: React.FC<{ lens: GlassLens }> = ({ lens }) => (
  <filter id={lens.id} x="0" y="0" width="1" height="1" colorInterpolationFilters="sRGB">
    <feImage href={displacementMap('x', lens.bandX)} preserveAspectRatio="none" result="mx" />
    <feImage href={displacementMap('y', lens.bandY)} preserveAspectRatio="none" result="my" />
    <feComposite in="mx" in2="my" operator="arithmetic" k2={1} k3={1} result="map" />
    <feDisplacementMap in="SourceGraphic" in2="map" scale={lens.scale} xChannelSelector="R" yChannelSelector="G" />
  </filter>
);

interface LiquidGlassProps {
  /** The `.os-root` element that carries `data-glass` for os.css. */
  target: React.RefObject<HTMLElement | null>;
  /** The Appearance switch, already false until the saved look has been read. */
  enabled: boolean;
  reducedMotion: boolean;
}

/**
 * Picks the Liquid Glass tier and writes it to `target[data-glass]` directly, so a tier change only
 * re-renders this component, never the desktop around it. On the `liquid` tier it also renders the
 * refraction filters that `backdrop-filter: url(#zos-lg-*)` points at in os.css; other browsers and
 * phones never get them.
 */
export const LiquidGlass: React.FC<LiquidGlassProps> = ({ target, enabled, reducedMotion }) => {
  const compact = useMediaQuery(GLASS_QUERIES.compact);
  const reducedTransparency = useMediaQuery(GLASS_QUERIES.reducedTransparency);
  const [engine, setEngine] = useState<Pick<GlassCapabilities, 'chromium' | 'backdropFilter'> | null>(null);
  useEffect(() => setEngine(readEngineCapabilities(window)), []);

  const tier: GlassTier = engine ? glassTier(enabled, { ...engine, compact, reducedMotion, reducedTransparency }) : 'off';
  useLayoutEffect(() => {
    const el = target.current;
    if (el) el.dataset.glass = tier;
  }, [target, tier]);

  if (tier !== 'liquid') return null;
  return (
    <svg className="os-lg-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        {Object.values(GLASS_LENSES).map(lens => <Lens key={lens.id} lens={lens} />)}
      </defs>
    </svg>
  );
};
