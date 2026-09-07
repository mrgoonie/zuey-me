import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

// Fetch real avatar from CDN
let avatarBase64 = '';
try {
  const resp = await fetch('https://cdn.zuey.me/avatar.png');
  if (resp.ok) {
    const arrayBuffer = await resp.arrayBuffer();
    avatarBase64 = `data:image/png;base64,${Buffer.from(arrayBuffer).toString('base64')}`;
  }
} catch (e) {
  console.warn('Could not fetch remote avatar:', e);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#2E1C2B" />
      <stop offset="60%" stop-color="#1E121C" />
      <stop offset="100%" stop-color="#120A11" />
    </linearGradient>
    <radialGradient id="glow1" cx="0.85" cy="0.15" r="0.6">
      <stop offset="0%" stop-color="#FF6B4A" stop-opacity="0.3" />
      <stop offset="100%" stop-color="#FF6B4A" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="glow2" cx="0.15" cy="0.85" r="0.6">
      <stop offset="0%" stop-color="#A855F7" stop-opacity="0.25" />
      <stop offset="100%" stop-color="#A855F7" stop-opacity="0" />
    </radialGradient>
    <clipPath id="avatarClip">
      <circle cx="600" cy="220" r="90" />
    </clipPath>
  </defs>

  <!-- Background -->
  <rect width="1200" height="630" fill="url(#bg)" />
  <rect width="1200" height="630" fill="url(#glow1)" />
  <rect width="1200" height="630" fill="url(#glow2)" />

  <!-- Outer Border Frame -->
  <rect x="30" y="30" width="1140" height="570" rx="36" fill="none" stroke="#FFFFFF" stroke-opacity="0.12" stroke-width="2" />

  <!-- Avatar Ring -->
  <circle cx="600" cy="220" r="96" fill="none" stroke="#FBBF24" stroke-width="4" stroke-opacity="0.85" />
  <circle cx="600" cy="220" r="92" fill="#3A2434" />
  <image href="${avatarBase64}" x="510" y="130" width="180" height="180" clip-path="url(#avatarClip)" />

  <!-- Verified Badge -->
  <circle cx="675" cy="290" r="16" fill="#FBBF24" />
  <path d="M668 290l5 5 10-10" fill="none" stroke="#1E121C" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />

  <!-- Profile Name -->
  <text x="600" y="375" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="46" font-weight="800" fill="#FFFFFF" letter-spacing="-0.02em">
    Duy Nguyen /zuey/
  </text>

  <!-- Subtitle Tagline -->
  <text x="600" y="425" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="22" font-weight="500" fill="#E9D5FF" opacity="0.95">
    "F*ck Around &amp; Find Out" Specialist • CTO &amp; Founder
  </text>

  <!-- Tag Badges -->
  <g transform="translate(600, 485)">
    <g transform="translate(-360, 0)">
      <rect x="-75" y="-18" width="150" height="36" rx="18" fill="#FFFFFF" fill-opacity="0.08" stroke="#FFFFFF" stroke-opacity="0.15" />
      <text x="0" y="5" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="#FFFFFF">TOPGROUP</text>
    </g>
    <g transform="translate(-180, 0)">
      <rect x="-65" y="-18" width="130" height="36" rx="18" fill="#FFFFFF" fill-opacity="0.08" stroke="#FFFFFF" stroke-opacity="0.15" />
      <text x="0" y="5" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="#FFFFFF">DIGITOP</text>
    </g>
    <g transform="translate(0, 0)">
      <rect x="-70" y="-18" width="140" height="36" rx="18" fill="#FFFFFF" fill-opacity="0.08" stroke="#FFFFFF" stroke-opacity="0.15" />
      <text x="0" y="5" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="#FFFFFF">AgentKit</text>
    </g>
    <g transform="translate(180, 0)">
      <rect x="-65" y="-18" width="130" height="36" rx="18" fill="#FFFFFF" fill-opacity="0.08" stroke="#FFFFFF" stroke-opacity="0.15" />
      <text x="0" y="5" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="#FFFFFF">Dewee</text>
    </g>
    <g transform="translate(360, 0)">
      <rect x="-75" y="-18" width="150" height="36" rx="18" fill="#FFFFFF" fill-opacity="0.08" stroke="#FFFFFF" stroke-opacity="0.15" />
      <text x="0" y="5" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="#FFFFFF">Build in Public</text>
    </g>
  </g>

  <!-- Brand Pill Footer -->
  <g transform="translate(600, 560)">
    <rect x="-100" y="-18" width="200" height="36" rx="18" fill="#FBBF24" />
    <text x="0" y="5" text-anchor="middle" font-family="monospace" font-size="15" font-weight="700" fill="#1E121C">
      ✱ zuey.me
    </text>
  </g>
</svg>`;

const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: 1200 },
});

const pngData = resvg.render();
const pngBuffer = pngData.asPng();

if (!fs.existsSync('public')) {
  fs.mkdirSync('public', { recursive: true });
}

fs.writeFileSync(path.resolve('public/og.png'), pngBuffer);
console.log(`✓ Successfully rendered real avatar raster PNG: public/og.png (${pngBuffer.length} bytes)`);
