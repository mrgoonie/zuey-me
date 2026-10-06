import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  output: 'server',
  // The same check runs in src/middleware.ts, which exempts the OAuth/MCP machine endpoints.
  security: { checkOrigin: false },
  adapter: cloudflare({
    imageService: 'passthrough',
    // Local dev uses the local D1 state; remote-only bindings (Workers AI) stay unbound and fail honestly.
    platformProxy: { enabled: true, remoteBindings: false },
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
