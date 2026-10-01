import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    imageService: 'passthrough'
  }),
  integrations: [
    react(),
    tailwind({
      applyBaseStyles: false,
    }),
  ],
  vite: {
    build: {
      // Mermaid's core, diagram and ELK layout chunks (up to ~1.5 MB) are client-only and loaded lazily by diagram blocks.
      chunkSizeWarningLimit: 1600,
    },
    ssr: {
      noExternal: ['lucide-react', 'clsx', 'tailwind-merge'],
    },
  },
});
