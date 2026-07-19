import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        // The v3-sdk oracle ships sourcemaps pointing at sources it does not
        // publish, and Vite warns once per file. Nothing actionable, ~40 lines
        // of noise per run.
        logLevel: 'error',
        test: {
          name: 'core',
          root: './packages/core',
          environment: 'node',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'web',
          root: './apps/web',
          environment: 'jsdom',
          include: ['test/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
