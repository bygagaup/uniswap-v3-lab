import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // `packages/core` is consumed as TypeScript source in dev via the
  // "development" export condition — no build step between edit and reload.
  resolve: { conditions: ['development'] },
  build: { outDir: 'dist', sourcemap: true },
  server: {
    // Validates the single-origin assumption on day one rather than at M4:
    // in production the same Worker serves both, so /api must never be cross-origin.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
});
