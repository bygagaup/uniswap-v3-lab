/**
 * Captures real Uniswap V3 `Burn` events into test/fixtures/burns.mainnet.json.
 *
 * A Burn is the strongest oracle available for `amountsForLiquidity`: the pool
 * publishes the liquidity being removed *and* the exact token amounts it paid
 * out, computed by the contract's own rounding. Reproducing those to the wei
 * proves the whole liquidity path, not just its shape.
 *
 * The subtlety is which price the amounts were computed at. `slot0` read at the
 * end of the block is wrong — a swap later in the same block would have moved
 * it. Mint and Burn do not change `sqrtPriceX96`, so the price in effect is the
 * one reported by the most recent *Swap* at or before the burn's log position.
 * That is what this script pairs up.
 *
 * viem is used for event decoding: this script's entire job is producing
 * trustworthy fixtures, so hand-rolled ABI decoding is exactly the wrong place
 * to save a dependency. It is a devDependency and cannot reach production —
 * test/packaging.test.ts enforces that.
 *
 * Run: pnpm --filter @poollab/core gen:burns
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';

/**
 * `eth_getLogs` over a block range counts as an archive request on most free
 * endpoints. publicnode and ankr refuse it outright; drpc serves it. Override
 * with MAINNET_RPC_URL if you have a paid endpoint.
 */
const RPC_URL = process.env.MAINNET_RPC_URL ?? 'https://eth.drpc.org';

const POOLS = [
  { address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', note: 'USDC/WETH 0.05%' },
  { address: '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8', note: 'USDC/WETH 0.3%' },
  { address: '0xcbcdf9626bc03e24f779434178a73a0b4bad62ed', note: 'WBTC/WETH 0.3%' },
] as const;

const POOL_ABI = parseAbi([
  'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
]);

/**
 * Free endpoints cap a single eth_getLogs span, so sweep a wide window in
 * chunks. Non-zero-liquidity burns are rarer than they look — most Burn logs on
 * a busy pool are the zero-amount fee-collection idiom.
 */
const WINDOW_BLOCKS = 20_000n;
const CHUNK_BLOCKS = 500n;
const MAX_PER_POOL = 5;

const client = createPublicClient({ chain: mainnet, transport: http(RPC_URL) });

interface BurnFixture {
  readonly note: string;
  readonly pool: string;
  readonly blockNumber: number;
  readonly logIndex: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: string;
  readonly amount0: string;
  readonly amount1: string;
  /** From the most recent Swap at or before this burn — the price it used. */
  readonly sqrtPriceX96: string;
  readonly tick: number;
  readonly priceFromBlock: number;
  readonly priceFromLogIndex: number;
}

async function capturePool(
  pool: (typeof POOLS)[number],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<BurnFixture[]> {
  const address = pool.address as `0x${string}`;

  const burns: Awaited<ReturnType<typeof client.getLogs<(typeof POOL_ABI)[0]>>> = [];
  const swaps: Awaited<ReturnType<typeof client.getLogs<(typeof POOL_ABI)[1]>>> = [];

  for (let start = fromBlock; start <= toBlock; start += CHUNK_BLOCKS) {
    const end = start + CHUNK_BLOCKS - 1n > toBlock ? toBlock : start + CHUNK_BLOCKS - 1n;
    const [b, s] = await Promise.all([
      client.getLogs({ address, event: POOL_ABI[0], fromBlock: start, toBlock: end }),
      client.getLogs({ address, event: POOL_ABI[1], fromBlock: start, toBlock: end }),
    ]);
    burns.push(...b);
    swaps.push(...s);
  }

  // Ascending by position, so "the most recent swap before X" is a scan backwards.
  const ordered = swaps
    .filter((s) => s.blockNumber !== null && s.logIndex !== null)
    .sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? (a.logIndex ?? 0) - (b.logIndex ?? 0)
        : Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)),
    );

  const out: BurnFixture[] = [];

  for (const burn of burns) {
    if (out.length >= MAX_PER_POOL) break;

    const { amount, amount0, amount1 } = burn.args;
    const { tickLower, tickUpper } = burn.args;
    if (
      amount === undefined ||
      amount0 === undefined ||
      amount1 === undefined ||
      tickLower === undefined ||
      tickUpper === undefined
    ) {
      continue;
    }

    // A zero-liquidity burn is the idiom for collecting fees; it moves no tokens
    // through the liquidity math and would prove nothing.
    if (amount === 0n) continue;
    if (amount0 === 0n && amount1 === 0n) continue;
    if (burn.blockNumber === null || burn.logIndex === null) continue;

    const priorSwap = [...ordered]
      .reverse()
      .find(
        (s) =>
          (s.blockNumber ?? 0n) < burn.blockNumber ||
          ((s.blockNumber ?? 0n) === burn.blockNumber && (s.logIndex ?? 0) < burn.logIndex),
      );

    // Without a preceding swap in the window we cannot know the exact price.
    if (!priorSwap?.args.sqrtPriceX96 || priorSwap.args.tick === undefined) continue;

    out.push({
      note: pool.note,
      pool: pool.address,
      blockNumber: Number(burn.blockNumber),
      logIndex: burn.logIndex,
      tickLower,
      tickUpper,
      liquidity: amount.toString(),
      amount0: amount0.toString(),
      amount1: amount1.toString(),
      sqrtPriceX96: priorSwap.args.sqrtPriceX96.toString(),
      tick: priorSwap.args.tick,
      priceFromBlock: Number(priorSwap.blockNumber ?? 0n),
      priceFromLogIndex: priorSwap.logIndex ?? 0,
    });
  }

  return out;
}

async function main(): Promise<void> {
  const head = await client.getBlockNumber();
  const toBlock = head - 64n; // step back from the head so a reorg cannot bite
  const fromBlock = toBlock - WINDOW_BLOCKS;

  const burns: BurnFixture[] = [];
  for (const pool of POOLS) {
    const captured = await capturePool(pool, fromBlock, toBlock);
    burns.push(...captured);
    process.stdout.write(`${pool.note}: ${captured.length} burns\n`);
  }

  if (burns.length === 0) throw new Error('captured no usable burns — widen the window');

  const outPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'test',
    'fixtures',
    'burns.mainnet.json',
  );
  writeFileSync(
    outPath,
    `${JSON.stringify(
      { chain: 'mainnet', fromBlock: Number(fromBlock), toBlock: Number(toBlock), burns },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`wrote ${outPath} with ${burns.length} burns\n`);
}

await main();
