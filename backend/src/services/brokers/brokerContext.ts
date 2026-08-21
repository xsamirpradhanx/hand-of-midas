/**
 * Per-request broker principal, carried without threading a userId through
 * every provider, engine and factor call site.
 *
 * The alternative — adding a `userId` parameter to fetchOptionsChainSchwab,
 * getQuoteSchwab, providerService, predictiveEngine, screenerService and every
 * factor beneath them — touches dozens of files whose logic has nothing to do
 * with identity, and still leaves the scheduled Lambdas with no sensible value
 * to pass.
 *
 * AsyncLocalStorage keeps the value pinned to the async execution context, so
 * concurrent requests in the local dev server each see their own principal.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { SYSTEM_PRINCIPAL } from './types.js';

interface BrokerContext {
  readonly principal: string;
}

const storage = new AsyncLocalStorage<BrokerContext>();

/**
 * Run `fn` with `principal` as the active broker identity.
 *
 * Wrap the Lambda handler (or dev-server request) in this. Anything downstream
 * that opens a broker connection resolves to this principal for the duration
 * of the invocation and nothing beyond it.
 */
export function runWithBrokerPrincipal<T>(principal: string, fn: () => T): T {
  return storage.run({ principal }, fn);
}

/**
 * The active principal, or SYSTEM when there is no request context.
 *
 * SYSTEM is the correct answer for scheduled work, which legitimately has no
 * user. It is deliberately NOT a fallback to "whoever was last seen": an
 * unauthenticated code path must reach the app's own connection, never a
 * customer's.
 */
export function currentBrokerPrincipal(): string {
  return storage.getStore()?.principal ?? SYSTEM_PRINCIPAL;
}

/** True when running outside any request scope — i.e. background work. */
export function isSystemContext(): boolean {
  return storage.getStore() === undefined;
}
