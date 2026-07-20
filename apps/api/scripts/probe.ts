/**
 * Probes every configured (chain, operation) pair against the real gateway.
 *
 * This runs the ACTUAL operation documents, not a liveness ping. A deployment
 * that answers `{ __typename }` may still lack `feeGrowthGlobal0X128`, reject
 * `pools(orderBy: volumeUSD)`, or have no `ticks` entity — all three happen in
 * practice, and all three are invisible to a health check.
 *
 * Run before trusting any new subgraph ID, and nightly to catch upstream drift.
 *
 * Run: pnpm --filter @poollab/api probe
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chainConfigs, describeChains, subgraphUrl } from '../src/chains.js';
import { OPERATIONS, type OpName } from '../src/operations.js';

/** Loads GRAPH_API_KEY from .dev.vars so the script needs no shell setup. */
function loadKey(): string {
  if (process.env.GRAPH_API_KEY) return process.env.GRAPH_API_KEY;

  const devVars = join(dirname(fileURLToPath(import.meta.url)), '..', '.dev.vars');
  try {
    const match = readFileSync(devVars, 'utf8').match(/^GRAPH_API_KEY=(.+)$/m);
    if (match?.[1]) return match[1].trim();
  } catch {
    // fall through to the error below
  }
  throw new Error('GRAPH_API_KEY not set and not found in apps/api/.dev.vars');
}

/** Representative variables per operation. Real pools, so the queries return rows. */
const SAMPLE_POOLS: Record<string, string> = {
  ethereum: '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8',
  polygon: '0x45dda9cb7c25131df268515131f647d726f50608',
  base: '0xd0b53d9277642d899df5c87a3966a349a798f224',
  optimism: '0x85149247691df622eaf1a8bd0cafd40bc45154a9',
  arbitrum: '0xc6962004f452be9203591991d15f6b388e09e8d0',
  bnb: '0x36696169c63e42cd08ce11f5deebbcebae652050',
  unichain: '0x3258f413c7a88cda2fa8709a589d221a80f6574f',
};

function variablesFor(op: OpName, pool: string): Record<string, unknown> {
  switch (op) {
    case 'poolById':
      return { id: pool };
    case 'poolsByIds':
      return { ids: [pool] };
    case 'poolsByToken':
      return { token: pool };
    case 'poolsByTokens':
      return { tokens: [pool] };
    case 'poolCurrentPrices':
    case 'poolDayData':
    case 'ticksByPool':
      return { pool };
    case 'poolHourData':
      return { pool, fromdate: Math.floor(Date.now() / 1000) - 7 * 24 * 3600 };
    case 'tokensBySymbol':
      return { symbol: 'USDC' };
    default:
      return {};
  }
}

interface Result {
  chain: string;
  op: string;
  status: 'ok' | 'empty' | 'error' | 'expected-gap';
  detail: string;
}

async function probe(
  chain: string,
  op: OpName,
  apiKey: string,
  supported: boolean,
): Promise<Result> {
  const operation = OPERATIONS[op];
  const pool = SAMPLE_POOLS[chain] ?? SAMPLE_POOLS.ethereum ?? '';
  const url = subgraphUrl(process.env as Record<string, string | undefined>, chain, op, apiKey);
  if (!url) return { chain, op, status: 'error', detail: 'no subgraph configured' };

  const parsed = operation.variables.safeParse(variablesFor(op, pool));
  if (!parsed.success) {
    return { chain, op, status: 'error', detail: `bad sample variables: ${parsed.error.message}` };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: operation.document, variables: parsed.data }),
    });
    if (!res.ok) return { chain, op, status: 'error', detail: `HTTP ${res.status}` };

    const body = (await res.json()) as {
      data?: Record<string, unknown>;
      errors?: { message: string }[];
    };
    if (body.errors?.length) {
      const detail = body.errors
        .map((e) => e.message)
        .join('; ')
        .slice(0, 160);
      // A schema gap on a chain whose capabilities already exclude this op is
      // the documented reason backtesting is off there — expected, not a fault.
      // But if it happens where we DO claim support, that is real drift.
      return { chain, op, status: supported ? 'error' : 'expected-gap', detail };
    }

    const rows = Object.values(body.data ?? {}).reduce<number>(
      (n, v) => n + (Array.isArray(v) ? v.length : 0),
      0,
    );
    return {
      chain,
      op,
      status: rows > 0 ? 'ok' : 'empty',
      detail: `${rows} rows`,
    };
  } catch (error) {
    return {
      chain,
      op,
      status: 'error',
      detail: error instanceof Error ? error.message : 'failed',
    };
  }
}

const MARK: Record<Result['status'], string> = {
  ok: '✓',
  empty: '·',
  'expected-gap': '—',
  error: '✗',
};

async function main(): Promise<void> {
  const apiKey = loadKey();
  const ops = Object.keys(OPERATIONS) as OpName[];
  const env = process.env as Record<string, string | undefined>;
  const capabilities = new Map(describeChains(env).map((d) => [d.slug, new Set(d.capabilities)]));
  const results: Result[] = [];

  for (const config of chainConfigs(env)) {
    for (const op of ops) {
      const supported = capabilities.get(config.slug)?.has(OPERATIONS[op].capability) ?? false;
      const result = await probe(config.slug, op, apiKey, supported);
      results.push(result);
      process.stdout.write(
        `${MARK[result.status]} ${config.slug.padEnd(9)} ${op.padEnd(18)} ${result.detail}\n`,
      );
    }
  }

  const failed = results.filter((r) => r.status === 'error');
  const gaps = results.filter((r) => r.status === 'expected-gap');
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} pairs healthy; ` +
      `${gaps.length} expected capability gaps; ${failed.length} unexpected failures\n`,
  );
  // Only unexpected failures fail the run. Documented capability gaps do not —
  // but an expected-gap that turns into a success would mean our capability map
  // is now stale, which is worth a human glance even though it is not fatal.
  if (failed.length > 0) process.exitCode = 1;
}

await main();
