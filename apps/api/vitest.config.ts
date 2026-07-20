import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// vitest-pool-workers 0.18 dropped the `defineWorkersConfig` helper in favour of
// a Vite plugin. The plugin gives tests a real workerd instance with a real
// caches.default and real bindings — not a mock.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: 'src/index.ts',
      miniflare: {
        compatibilityDate: '2025-11-01',
        compatibilityFlags: ['nodejs_compat'],
        // A dummy key: the gateway fetch is stubbed, so the value is never used
        // against a real endpoint, but its presence is what the handler checks.
        bindings: { ENVIRONMENT: 'test', GRAPH_API_KEY: 'test-key' },
      },
    }),
  ],
  test: {
    name: 'api',
    include: ['test/**/*.test.ts'],
  },
});
