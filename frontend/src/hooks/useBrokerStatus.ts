import { useCallback, useEffect, useState } from 'react';
import { api, type BrokerStatusResponse } from '../lib/api';

/** Disconnections are resolved by a human re-authorizing, so poll slowly. */
const POLL_MS = 60_000;

/**
 * Connection state for the signed-in user's brokerages.
 *
 * Deliberately separate from the per-request fallback signal: a request falling
 * back once is noise, whereas a broker that cannot be reached at all is a
 * standing condition the user has to act on. The endpoint answers from stored
 * state and never mints a token, so polling it cannot burn a refresh grant.
 */
export function useBrokerStatus() {
  const [status, setStatus] = useState<BrokerStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.getBrokerStatus());
    } catch {
      // A failed status check is not itself a broker outage — leave the last
      // known state rather than flashing a scary banner on a transient blip.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => { if (!cancelled) await refresh(); };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [refresh]);

  return { status, loading, refresh };
}
