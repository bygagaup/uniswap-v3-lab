import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useNavigate,
} from '@tanstack/react-router';
import { useChains, usePool } from './api/queries.js';
import type { ChainSlug, Pool } from './api/types.js';
import { ChainSwitcher } from './components/ChainSwitcher.js';
import { PoolPicker } from './components/PoolPicker.js';
import { StrategyView } from './components/StrategyView.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { parseSearch, type Search } from './state/search.js';

const rootRoute = createRootRoute({
  component: () => (
    <div className="app">
      <header className="topbar">
        <h1>PoolLab</h1>
        <span className="spacer" />
        <ThemeToggle />
      </header>
      <Outlet />
    </div>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (raw: Record<string, unknown>): Search => parseSearch(raw),
  component: HomePage,
});

function HomePage() {
  const search = indexRoute.useSearch();
  const navigate = useNavigate({ from: indexRoute.fullPath });
  const chainsQuery = useChains();
  const poolQuery = usePool(search.chain, search.pool);

  // Every state change is a URL change — the address bar is the store.
  const setChain = (chain: ChainSlug) =>
    navigate({
      search: (prev: Search) => ({
        ...prev,
        chain,
        pool: undefined,
        lower: undefined,
        upper: undefined,
      }),
    });
  const setQuery = (q: string) =>
    navigate({ search: (prev: Search) => ({ ...prev, q: q || undefined }), replace: true });
  // A new pool clears the range/orientation so they default to the new pool.
  const selectPool = (pool: Pool) =>
    navigate({
      search: (prev: Search) => ({
        chain: prev.chain,
        notional: prev.notional,
        inv: false,
        pool: pool.id.toLowerCase(),
      }),
    });

  const strategyHandlers = {
    onNotional: (notional: number) =>
      navigate({ search: (prev: Search) => ({ ...prev, notional }) }),
    onRange: (lower: number, upper: number) =>
      navigate({ search: (prev: Search) => ({ ...prev, lower, upper }) }),
    onToggleInvert: () => navigate({ search: (prev: Search) => ({ ...prev, inv: !prev.inv }) }),
  };

  return (
    <>
      <div style={{ padding: '12px 20px 0', maxWidth: 1200, margin: '0 auto', width: '100%' }}>
        {chainsQuery.isSuccess && (
          <ChainSwitcher chains={chainsQuery.data} selected={search.chain} onSelect={setChain} />
        )}
      </div>

      <div className="content">
        <PoolPicker
          chain={search.chain}
          query={search.q ?? ''}
          selectedId={search.pool}
          onQueryChange={setQuery}
          onSelect={selectPool}
        />

        <main>
          {!search.pool && <p className="placeholder">Pick a pool to see its stats.</p>}
          {search.pool && poolQuery.isPending && <p className="placeholder">Loading pool…</p>}
          {search.pool && poolQuery.isError && (
            <p className="placeholder error" role="alert">
              {poolQuery.error instanceof Error ? poolQuery.error.message : 'Failed to load pool'}
            </p>
          )}
          {poolQuery.isSuccess && poolQuery.data && (
            <StrategyView
              chain={search.chain}
              pool={poolQuery.data}
              input={{
                notional: search.notional,
                lower: search.lower,
                upper: search.upper,
                inverted: search.inv,
              }}
              handlers={strategyHandlers}
            />
          )}
          {poolQuery.isSuccess && !poolQuery.data && (
            <p className="placeholder">That pool was not found on this chain.</p>
          )}
        </main>
      </div>
    </>
  );
}

const routeTree = rootRoute.addChildren([indexRoute]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
