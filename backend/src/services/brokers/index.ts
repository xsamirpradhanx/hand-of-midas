/**
 * Entry point for broker connections.
 *
 * Always construct per request. Never hold the returned connection in module
 * scope — see the note on BrokerConnection in types.ts.
 */
import { currentBrokerPrincipal } from './brokerContext.js';
import { getBrokerTokenStore } from './tokenStore.js';
import { SchwabConnection } from './schwabConnection.js';
import { isDeployed } from './cipher.js';
import { SYSTEM_PRINCIPAL } from './types.js';

/**
 * Which principal's credentials a connection should use.
 *
 * Deployed, this is the caller: per-user credentials are the whole point, and
 * collapsing principals would reintroduce the cross-user bleed this module was
 * built to remove.
 *
 * Locally it is always SYSTEM. A developer machine has one Schwab login held in
 * one token file, so keying it by a Cognito sub would report "not connected" for
 * the very developer who just ran `npm run schwab-auth`. The collapse is safe
 * here precisely because the local store is single-tenant by construction — it
 * rejects non-SYSTEM writes outright.
 */
function resolvePrincipal(explicit?: string): string {
  if (explicit) return explicit;
  return isDeployed() ? currentBrokerPrincipal() : SYSTEM_PRINCIPAL;
}

export function schwabFor(principal?: string): SchwabConnection {
  return new SchwabConnection(resolvePrincipal(principal), getBrokerTokenStore());
}

export { SchwabRefreshRevokedError } from './schwabConnection.js';
export { runWithBrokerPrincipal, currentBrokerPrincipal, isSystemContext } from './brokerContext.js';
export { getBrokerTokenStore, setBrokerTokenStoreForTesting } from './tokenStore.js';
export * from './types.js';
