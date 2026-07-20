/**
 * Responsive smoke test: loads a fully-populated pool view at five widths and
 * asserts the page never scrolls horizontally and never renders the string
 * "NaN" — the two failure modes that leak from a d3 scale into an SVG attribute
 * or a formatter given a bad number.
 *
 * Manual (needs the dev servers up), not part of `pnpm test`, so CI stays
 * offline. Run:
 *   pnpm --filter @poollab/api dev &   pnpm --filter @poollab/web dev &
 *   node apps/web/scripts/smoke.mjs
 */
import { chromium } from 'playwright-core';

const EXE =
  process.env.CHROMIUM_PATH ??
  `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const BASE = process.env.SMOKE_URL ?? 'http://localhost:5173';
const WIDTHS = [360, 600, 900, 1280, 1600];

// A pool + a fully-loaded view: leverage, hedge, and an S2 comparison range on.
const PATH =
  '/?chain=ethereum&pool=0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640&lev=3&hedge=short&lower2=199000&upper2=203000';

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
let failures = 0;

for (const width of WIDTHS) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  await page.goto(`${BASE}${PATH}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('svg[aria-label^="Payoff"]', { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(800);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  const nanText = await page.evaluate(
    () => (document.body.innerText.match(/\bNaN\b/g) ?? []).length,
  );
  const nanAttr = await page.evaluate(() =>
    [...document.querySelectorAll('*')].some((el) =>
      [...el.attributes].some((a) => a.value.includes('NaN')),
    ),
  );

  const ok = !overflow && nanText === 0 && !nanAttr;
  if (!ok) failures++;
  process.stdout.write(
    `${ok ? '✓' : '✗'} ${String(width).padStart(4)}px  overflow=${overflow}  NaN-text=${nanText}  NaN-attr=${nanAttr}\n`,
  );
  await page.close();
}

await browser.close();
process.stdout.write(failures === 0 ? '\nall widths clean\n' : `\n${failures} width(s) failed\n`);
process.exitCode = failures === 0 ? 0 : 1;
