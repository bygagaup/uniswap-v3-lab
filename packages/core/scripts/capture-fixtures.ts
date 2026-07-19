/**
 * Captures real mainnet pool state into test/fixtures/pools.mainnet.json.
 *
 * Run manually; the output is committed so the test suite stays offline and
 * deterministic. A nightly job re-runs it to catch upstream drift.
 *
 * Run: pnpm --filter @poollab/core gen:fixtures
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RPC_URL = process.env.MAINNET_RPC_URL ?? 'https://ethereum-rpc.publicnode.com';

/** Canonical Uniswap V3 pools spanning the decimal pairs and fee tiers we care about. */
const POOLS: readonly { address: string; note: string }[] = [
  { address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', note: 'USDC/WETH 0.05%' },
  { address: '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8', note: 'USDC/WETH 0.3%' },
  { address: '0xcbcdf9626bc03e24f779434178a73a0b4bad62ed', note: 'WBTC/WETH 0.3%' },
  { address: '0x5777d92f208679db4b9778590fa3cab3ac9e2168', note: 'DAI/USDC 0.01%' },
];

const SELECTOR = {
  slot0: '0x3850c7bd',
  liquidity: '0x1a686502',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  fee: '0xddca3f43',
  tickSpacing: '0xd0c93a7c',
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
} as const;

let rpcId = 0;

async function rpc(method: string, params: unknown[]): Promise<string> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}`);
  const body = (await res.json()) as { result?: string; error?: { message: string } };
  if (body.error) throw new Error(`${method} -> ${body.error.message}`);
  if (body.result === undefined) throw new Error(`${method} -> no result`);
  return body.result;
}

function call(to: string, data: string, block: string): Promise<string> {
  return rpc('eth_call', [{ to, data }, block]);
}

/** Splits `0x`-prefixed return data into 32-byte words. */
function words(hex: string): string[] {
  const body = hex.slice(2);
  const out: string[] = [];
  for (let i = 0; i < body.length; i += 64) out.push(body.slice(i, i + 64));
  return out;
}

function toBigInt(word: string): bigint {
  return BigInt(`0x${word}`);
}

/** Two's-complement decode for the signed int24 that slot0 packs into a word. */
function toInt24(word: string): number {
  const raw = toBigInt(word);
  const sign = 1n << 23n;
  return Number(raw & (sign - 1n)) - (raw & sign ? Number(sign) : 0);
}

function decodeString(hex: string): string {
  const w = words(hex);
  const length = Number(toBigInt(w[1] as string));
  const bytes = (w[2] ?? '').slice(0, length * 2);
  return Buffer.from(bytes, 'hex').toString('utf8');
}

async function erc20(address: string, block: string) {
  const [decimals, symbol] = await Promise.all([
    call(address, SELECTOR.decimals, block),
    call(address, SELECTOR.symbol, block),
  ]);
  return {
    address,
    decimals: Number(toBigInt(words(decimals)[0] as string)),
    symbol: decodeString(symbol),
  };
}

async function capturePool(address: string, note: string, block: string) {
  const [slot0, liquidity, t0, t1, fee, spacing] = await Promise.all([
    call(address, SELECTOR.slot0, block),
    call(address, SELECTOR.liquidity, block),
    call(address, SELECTOR.token0, block),
    call(address, SELECTOR.token1, block),
    call(address, SELECTOR.fee, block),
    call(address, SELECTOR.tickSpacing, block),
  ]);

  const s = words(slot0);
  const token0Address = `0x${(words(t0)[0] as string).slice(24)}`;
  const token1Address = `0x${(words(t1)[0] as string).slice(24)}`;

  const [token0, token1] = await Promise.all([
    erc20(token0Address, block),
    erc20(token1Address, block),
  ]);

  return {
    note,
    address,
    token0,
    token1,
    feeTier: Number(toBigInt(words(fee)[0] as string)),
    tickSpacing: Number(toBigInt(words(spacing)[0] as string)),
    sqrtPriceX96: toBigInt(s[0] as string).toString(),
    tick: toInt24(s[1] as string),
    liquidity: toBigInt(words(liquidity)[0] as string).toString(),
  };
}

async function main(): Promise<void> {
  // Pin to a specific block so the fixture is reproducible, and step back from
  // the head so a reorg cannot invalidate what we committed.
  const head = Number(await rpc('eth_blockNumber', []));
  const block = `0x${(head - 64).toString(16)}`;

  const pools = [];
  for (const { address, note } of POOLS) {
    pools.push(await capturePool(address, note, block));
    process.stdout.write(`captured ${note}\n`);
  }

  const outPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'test',
    'fixtures',
    'pools.mainnet.json',
  );
  writeFileSync(
    outPath,
    `${JSON.stringify({ chain: 'mainnet', blockNumber: Number(block), pools }, null, 2)}\n`,
  );
  process.stdout.write(`wrote ${outPath} at block ${Number(block)}\n`);
}

await main();
