import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('packaging', () => {
  it('declares no runtime dependencies', () => {
    // The math core is the piece most worth reusing and the piece least able to
    // afford a supply chain. Everything it needs, BigInt already provides.
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('keeps the test oracles in devDependencies, where they cannot ship', () => {
    const dev = pkg.devDependencies ?? {};
    for (const oracle of ['@uniswap/v3-sdk', '@uniswap/sdk-core']) {
      expect(Object.keys(dev)).toContain(oracle);
      expect(Object.keys(pkg.dependencies ?? {})).not.toContain(oracle);
    }
  });

  it('imports no oracle from src', () => {
    // Biome enforces this too; asserting it here means a rules refactor cannot
    // quietly drop the guarantee.
    const srcDir = join(here, '../src');
    const sources = readdirSync(srcDir, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.ts'),
    );

    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const source = readFileSync(join(srcDir, file), 'utf8');
      expect(source, `src/${file} imports a test-only oracle`).not.toMatch(
        /@uniswap\/(v3-sdk|sdk-core)|decimal\.js/,
      );
    }
  });
});
