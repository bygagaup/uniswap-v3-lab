/**
 * Captures a real poolHourData window (with feeGrowthGlobal) into
 * test/fixtures/hours.mainnet.json.
 *
 * This is the fixture that demonstrates the fix concretely: feeGrowthGlobalX128
 * on a busy pool is a ~78-digit number, far above Number.MAX_SAFE_INTEGER. The
 * predecessor's parseInt() collapsed it; the test replays these exact values
 * through the BigInt path and checks the fees come out finite and sane.
 *
 * Run: pnpm --filter @poollab/core gen:hours
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RPC = 'https://gateway.thegraph.com/api';
const ETHEREUM = '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';
const POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640'; // USDC/WETH 0.05%

function apiKey(): string {
  if (process.env.GRAPH_API_KEY) return process.env.GRAPH_API_KEY;
  const devVars = join(dirname(fileURLToPath(import.meta.url)), '../../../apps/api/.dev.vars');
  const match = readFileSync(devVars, 'utf8').match(/^GRAPH_API_KEY=(.+)$/m);
  if (!match?.[1]) throw new Error('GRAPH_API_KEY not found');
  return match[1].trim();
}

const POOL_DOC = `query Pool($id: ID!) {
  pool(id: $id) {
    tick sqrtPrice feeTier
    totalValueLockedUSD totalValueLockedToken0 totalValueLockedToken1
    token0 { id symbol decimals } token1 { id symbol decimals }
  }
}`;

const HOURS_DOC = `query Hours($pool: String!, $from: Int!) {
  poolHourDatas(
    first: 720, orderBy: periodStartUnix, orderDirection: desc,
    where: { pool: $pool, periodStartUnix_gt: $from, close_gt: 0 }
  ) {
    periodStartUnix high low close feeGrowthGlobal0X128 feeGrowthGlobal1X128
  }
}`;

async function query(
  key: string,
  doc: string,
  variables: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${RPC}/${key}/subgraphs/id/${ETHEREUM}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: doc, variables }),
  });
  const body = (await res.json()) as {
    data?: Record<string, unknown>;
    errors?: { message: string }[];
  };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  if (!body.data) throw new Error('no data');
  return body.data;
}

async function main(): Promise<void> {
  const key = apiKey();
  const from = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;

  const { pool } = (await query(key, POOL_DOC, { id: POOL })) as { pool: Record<string, unknown> };
  const { poolHourDatas } = (await query(key, HOURS_DOC, { pool: POOL, from })) as {
    poolHourDatas: Record<string, string>[];
  };

  // The subgraph returns newest-first; the backtest wants ascending.
  const candles = poolHourDatas
    .map((h) => ({
      periodStartUnix: Number(h.periodStartUnix),
      high: h.high,
      low: h.low,
      close: h.close,
      feeGrowthGlobal0X128: h.feeGrowthGlobal0X128,
      feeGrowthGlobal1X128: h.feeGrowthGlobal1X128,
    }))
    .sort((a, b) => a.periodStartUnix - b.periodStartUnix);

  const t0 = pool.token0 as Record<string, string>;
  const t1 = pool.token1 as Record<string, string>;

  const out = {
    chain: 'mainnet',
    pool: {
      address: POOL,
      tick: Number(pool.tick),
      sqrtPrice: pool.sqrtPrice,
      feeTier: Number(pool.feeTier),
      tvl: {
        usd: Number(pool.totalValueLockedUSD),
        token0: Number(pool.totalValueLockedToken0),
        token1: Number(pool.totalValueLockedToken1),
      },
      token0: { id: t0.id, symbol: t0.symbol, decimals: Number(t0.decimals) },
      token1: { id: t1.id, symbol: t1.symbol, decimals: Number(t1.decimals) },
    },
    candles,
  };

  const outPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'test',
    'fixtures',
    'hours.mainnet.json',
  );
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  process.stdout.write(`wrote ${outPath}: ${candles.length} candles\n`);
}

await main();
