import React from 'react';
import { GLASS_LENSES, displacementMap, type GlassLens } from './liquid-glass';

const Lens: React.FC<{ lens: GlassLens }> = ({ lens }) => (
  <filter id={lens.id} x="0" y="0" width="1" height="1" colorInterpolationFilters="sRGB">
    <feImage href={displacementMap('x', lens.bandX)} preserveAspectRatio="none" result="mx" />
    <feImage href={displacementMap('y', lens.bandY)} preserveAspectRatio="none" result="my" />
    <feComposite in="mx" in2="my" operator="arithmetic" k2={1} k3={1} result="map" />
    <feDisplacementMap in="SourceGraphic" in2="map" scale={lens.scale} xChannelSelector="R" yChannelSelector="G" />
  </filter>
);

/**
 * The refraction filters that `backdrop-filter: url(#zos-lg-*)` points at in os.css. Rendered by
 * ZueyOS only on the `liquid` tier, so other browsers and phones never download or parse them.
 */
export const LiquidGlassFilters: React.FC = () => (
  <svg className="os-lg-defs" width="0" height="0" aria-hidden="true" focusable="false">
    <defs>
      {Object.values(GLASS_LENSES).map(lens => <Lens key={lens.id} lens={lens} />)}
    </defs>
  </svg>
);
