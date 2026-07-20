import { SubgraphError } from '../api/client.js';
import { useSearch, useTopPools } from '../api/queries.js';
import type { ChainSlug, Pool } from '../api/types.js';
import { PoolList } from './PoolList.js';

function errorMessage(error: unknown): string {
  if (error instanceof SubgraphError) return error.message;
  return error instanceof Error ? error.message : 'Something went wrong';
}

/**
 * Below two characters the picker shows the top pools by volume; at two or more
 * it switches to search results. Both paths funnel into the same PoolList.
 */
export function PoolPicker({
  chain,
  query,
  selectedId,
  onQueryChange,
  onSelect,
}: {
  chain: ChainSlug;
  query: string;
  selectedId: string | undefined;
  onQueryChange: (q: string) => void;
  onSelect: (pool: Pool) => void;
}) {
  const searching = query.trim().length >= 2;
  const top = useTopPools(chain);
  const search = useSearch(chain, query);
  const active = searching ? search : top;

  return (
    <section className="card">
      <h2>Pool</h2>
      <input
        type="search"
        className="search-input"
        placeholder="Search by symbol or address…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        aria-label="Search pools"
      />

      {active.isPending && <p className="placeholder">Loading pools…</p>}
      {active.isError && (
        <p className="placeholder error" role="alert">
          {errorMessage(active.error)}
        </p>
      )}
      {active.isSuccess && (
        <PoolList pools={active.data} selectedId={selectedId} onSelect={onSelect} />
      )}
    </section>
  );
}
