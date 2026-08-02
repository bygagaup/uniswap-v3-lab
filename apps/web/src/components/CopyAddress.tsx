import { useEffect, useState } from 'react';

/**
 * The pool address, click-to-copy. Shows a brief "Copied" confirmation and falls
 * back silently if the Clipboard API is unavailable (non-secure context).
 */
export function CopyAddress({ address, display }: { address: string; display: string }) {
  const [copied, setCopied] = useState(false);

  // Clear the confirmation after a moment; cancel on unmount or re-copy.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      // No clipboard access (e.g. insecure origin) — leave the label unchanged.
    }
  };

  return (
    <button
      type="button"
      className="copy-address muted"
      onClick={copy}
      title={copied ? 'Copied' : `Copy ${address}`}
      aria-label={copied ? 'Address copied' : `Copy pool address ${address}`}
    >
      <span>{copied ? 'Copied' : display}</span>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        {copied ? (
          <path
            d="M20 6L9 17l-5-5"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <>
            <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
            <path
              d="M5 15V5a2 2 0 0 1 2-2h10"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </>
        )}
      </svg>
    </button>
  );
}
