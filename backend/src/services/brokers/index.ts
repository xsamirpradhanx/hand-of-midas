/**
 * Entry point for broker connections.
 *
 * Always construct per request. Never hold the returned connection in module
 * scope — see the note on BrokerConnection in types.ts.
 */
import { currentBrokerPrincipal } from './brokerContext.js';
import { getBrokerTokenStore } from './tokenStore.js';
import { SchwabConnection } from './schwabConnection.js';

export function schwabFor(principal?: string): SchwabConnection {
  return new SchwabConnection(principal ?? currentBrokerPrincipal(), getBrokerTokenStore());
}

export { SchwabRefreshRevokedError } from './schwabConnection.js';
export { runWithBrokerPrincipal, currentBrokerPrincipal, isSystemContext } from './brokerContext.js';
export { getBrokerTokenStore, setBrokerTokenStoreForTesting } from './tokenStore.js';
export * from './types.js';
