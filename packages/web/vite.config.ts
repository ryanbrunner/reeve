import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Defaults to the live board's own port (DEFAULT_PORT in
// @reeve/shared/src/api.ts; not imported here, since this config is loaded by
// Node directly rather than through Vite's own bundler, and Node can't load
// the workspace package's untranspiled .ts), so a developer running `npm run
// dev` against the real server needs nothing extra. A card whose server
// command runs Vite and the tsx API server side by side sets this to its own
// backend's port, so its UI's API calls land on its own worktree rather than
// the live board — recovering HMR for Preview, which a build-then-start
// command gives up to avoid this coupling.
const apiPort = process.env.REEVE_DEV_API_PORT ?? '4317';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
        configure: (proxy) => {
          // SSE must not be buffered by the dev proxy or the run transcript
          // arrives in one lump when the run finishes instead of live.
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
              delete proxyRes.headers['content-length'];
            }
          });
        },
      },
    },
  },
});
