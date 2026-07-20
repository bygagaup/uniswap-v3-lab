import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Measures an element's content width, synchronously on first layout and then
 * on resize. Unlike visx's ParentSize it starts from a real measurement rather
 * than 0, so a chart never has to render a null first frame — the flicker that
 * left the payoff card looking empty on load.
 */
export function useWidth<T extends HTMLElement>(
  fallback = 600,
): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setWidth(w);
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}
