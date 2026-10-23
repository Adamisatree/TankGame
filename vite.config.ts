import { defineConfig } from 'vite';

// The Arena preview proxies the dev server under https://<port>-<sandbox>.e2b.app.
// Allowing any host keeps that preview origin working.
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 2000,
  },
});
