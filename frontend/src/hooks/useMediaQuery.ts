import { useEffect, useState } from 'react';

/**
 * Subscribes to a CSS media query and re-renders when it flips.
 *
 * Reads synchronously on first render so the very first paint is already correct —
 * initialising to `false` and correcting in an effect makes the desktop layout
 * flash on a phone before collapsing.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** Single source of truth for the mobile breakpoint — mirrors the CSS at 768px. */
export const MOBILE_QUERY = '(max-width: 768px)';
export const useIsMobile = () => useMediaQuery(MOBILE_QUERY);
