/**
 * Captures the COMPLETE initialized-tick set for a few pools into
 * test/fixtures/ticks.mainnet.json.
 *
 * Completeness is the whole point: the density invariant — cumulative
 * liquidityNet at the current tick equals the pool's reported liquidity — only
 * holds if no tick is missing. `first: 1000` on its own truncates, so this
 * paginates on tickIdx_gt until a short page signals the end, then the test can
 * check `netSum === 0` to confirm nothing was dropped.
 *
 * Run: pnpm --filter @poollab/core gen:ticks-fixture
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RPC = 'https://gateway.thegraph.com/api';
const ETHEREUM = '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';

/** Pools with a moderate tick count, so the full set fits in a few pages. */
const POOLS = [
  { address: '0xcbcdf9626bc03e24f779434178a73a0b4bad62ed', note: 'WBTC/WETH 0.3%' },
  { address: '0x7bea39867e4169dbe237d55c8242a8f2fcdcc387', note: 'USDC/WETH 1%' },
];

const PAGE = 1000;

function apiKey(): string {
  if (process.env.GRAPH_API_KEY) return process.env.GRAPH_API_KEY;
  const devVars = join(dirname(fileURLToPath(import.meta.url)), '../../../apps/api/.dev.vars');
  const match = readFileSync(devVars, 'utf8').match(/^GRAPH_API_KEY=(.+)$/m);
  if (!match?.[1]) throw new Error('GRAPH_API_KEY not found');
  return match[1].trim();
}

interface RawTick {
  tickIdx: string;
  liquidityNet: string;
}

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

const POOL_DOC = `query Pool($id: ID!) {
  pool(id: $id) { tick liquidity sqrtPrice feeTier
    token0 { id symbol decimals } token1 { id symbol decimals } }
}`;

const TICKS_DOC = `query Ticks($pool: String!, $after: BigInt!) {
  ticks(first: ${PAGE}, orderBy: tickIdx, orderDirection: asc,
        where: { poolAddress: $pool, tickIdx_gt: $after }) {
    tickIdx liquidityNet
  }
}`;

async function capturePool(key: string, address: string) {
  const { pool } = (await query(key, POOL_DOC, { id: address })) as {
    pool: {
      tick: string;
      liquidity: string;
      sqrtPrice: string;
      feeTier: string;
      token0: { id: string; symbol: string; decimals: string };
      token1: { id: string; symbol: string; decimals: string };
    };
  };

  const ticks: { tickIdx: number; liquidityNet: string }[] = [];
  let after = -1_000_000; // below MIN_TICK, so the first page starts at the bottom
  for (;;) {
    const { ticks: page } = (await query(key, TICKS_DOC, { pool: address, after })) as {
      ticks: RawTick[];
    };
    if (page.length === 0) break;
    for (const t of page) ticks.push({ tickIdx: Number(t.tickIdx), liquidityNet: t.liquidityNet });
    after = Number((page[page.length - 1] as RawTick).tickIdx);
    if (page.length < PAGE) break;
  }

  return {
    pool: {
      address,
      tick: Number(pool.tick),
      liquidity: pool.liquidity,
      sqrtPrice: pool.sqrtPrice,
      feeTier: Number(pool.feeTier),
      token0: { ...pool.token0, decimals: Number(pool.token0.decimals) },
      token1: { ...pool.token1, decimals: Number(pool.token1.decimals) },
    },
    ticks,
  };
}

async function main(): Promise<void> {
  const key = apiKey();
  const pools = [];
  for (const p of POOLS) {
    const captured = await capturePool(key, p.address);
    pools.push({ note: p.note, ...captured });
    process.stdout.write(`${p.note}: ${captured.ticks.length} ticks\n`);
  }

  const outPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'test',
    'fixtures',
    'ticks.mainnet.json',
  );
  writeFileSync(outPath, `${JSON.stringify({ chain: 'mainnet', pools }, null, 2)}\n`);
  process.stdout.write(`wrote ${outPath}\n`);
}

await main();
