import type { ChainDescriptor, ChainSlug } from '../api/types.js';

/**
 * Chain picker. A chain the proxy has not configured is disabled, not hidden,
 * so the user sees it exists but is unavailable — and the availability comes
 * from /api/meta/chains, never a hardcoded list.
 */
export function ChainSwitcher({
  chains,
  selected,
  onSelect,
}: {
  chains: readonly ChainDescriptor[];
  selected: ChainSlug;
  onSelect: (chain: ChainSlug) => void;
}) {
  return (
    <fieldset className="chain-switcher">
      <legend className="sr-only">Chain</legend>
      {chains.map((chain) => {
        const usable = chain.capabilities.includes('pools');
        return (
          <button
            key={chain.slug}
            type="button"
            className="chip"
            aria-pressed={chain.slug === selected}
            disabled={!usable}
            title={usable ? chain.label : `${chain.label} is not configured`}
            onClick={() => onSelect(chain.slug)}
          >
            {chain.label}
          </button>
        );
      })}
    </fieldset>
  );
}
