/**
 * Store selection. DynamoDB when deployed (or when a table is configured),
 * the local token file otherwise.
 */
import { isDeployed } from './cipher.js';
import { DynamoBrokerTokenStore } from './dynamoTokenStore.js';
import { FileBrokerTokenStore } from './fileTokenStore.js';
import type { BrokerTokenStore } from './types.js';

let cached: BrokerTokenStore | undefined;

export function getBrokerTokenStore(): BrokerTokenStore {
  if (!cached) {
    cached = isDeployed() ? new DynamoBrokerTokenStore() : new FileBrokerTokenStore();
  }
  return cached;
}

/** Test seam. */
export function setBrokerTokenStoreForTesting(store: BrokerTokenStore | undefined): void {
  cached = store;
}
