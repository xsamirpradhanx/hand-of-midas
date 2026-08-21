/**
 * Broker connection primitives shared by every brokerage integration.
 *
 * Deliberately protocol-agnostic. Schwab is OAuth 2.0 (bearer token, 30-minute
 * access token, 7-day refresh token); E*TRADE is OAuth 1.0a (per-request
 * HMAC-SHA1 signature, access token expiring at midnight ET with no refresh
 * grant at all). A "give me a token" seam only models the first, so the
 * abstraction is *authorize this request* — see BrokerConnection.
 */

export type BrokerId = 'schwab' | 'etrade';

/**
 * Owner of a stored credential.
 *
 * Interactive requests carry the Cognito `sub`. Scheduled Lambdas (screener
 * refresh, chain refresh, evaluate-quant) run with no user at all, so they use
 * the SYSTEM principal — a single app-owned connection that powers background
 * market-data work. Keeping it an explicit, named principal rather than an
 * implicit fallback is what stops a background job from silently transacting
 * against whichever customer's token happened to be cached in the container.
 */
export const SYSTEM_PRINCIPAL = 'SYSTEM';

export interface StoredBrokerToken {
  readonly broker: BrokerId;
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch ms when the access token stops being usable. */
  readonly accessExpiresAt: number;
  /**
   * Epoch ms when the refresh grant itself dies and only a fresh browser
   * authorization can recover. Schwab pins this at 7 days; E*TRADE has no
   * refresh grant, so it equals accessExpiresAt.
   */
  readonly refreshExpiresAt: number;
  /** OAuth 1.0a needs the paired secret to sign; OAuth 2.0 leaves it undefined. */
  readonly tokenSecret?: string;
  readonly scope?: string;
  /**
   * Set once the provider has rejected the refresh grant as invalid/revoked.
   * Persisted rather than held in memory so one dead credential cannot be
   * re-tried by every warm container, and cannot disable a *different* user.
   */
  readonly revokedAt?: number;
  /** Optimistic-lock counter; see BrokerTokenStore.save. */
  readonly version: number;
}

/** A token payload as returned by a provider, before it has been stored. */
export type NewBrokerToken = Omit<StoredBrokerToken, 'version' | 'revokedAt'>;

/**
 * Thrown when a conditional write loses to a concurrent writer.
 *
 * Two invocations refreshing the same credential at once can have one provider
 * response invalidate the other, so the loser must re-read rather than retry
 * its own refresh.
 */
export class TokenConflictError extends Error {
  constructor(principal: string, broker: BrokerId) {
    super(`Concurrent token write for ${principal}/${broker}; re-read before retrying.`);
    this.name = 'TokenConflictError';
  }
}

export interface BrokerTokenStore {
  load(principal: string, broker: BrokerId): Promise<StoredBrokerToken | null>;
  /**
   * Persist a token.
   *
   * `expectedVersion` asserts the version the caller read; a mismatch raises
   * TokenConflictError instead of clobbering the winner's token. Pass 0 to
   * assert the credential does not exist yet.
   */
  save(
    principal: string,
    broker: BrokerId,
    token: NewBrokerToken,
    expectedVersion?: number,
  ): Promise<StoredBrokerToken>;
  /** Flag the refresh grant as dead, so nothing retries it until re-auth. */
  markRevoked(principal: string, broker: BrokerId): Promise<void>;
  clear(principal: string, broker: BrokerId): Promise<void>;
}

/** What an outbound provider request needs in order to be authorized. */
export interface OutboundRequest {
  readonly method: string;
  readonly url: string;
  readonly params?: Record<string, string>;
}

export interface AuthorizedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

export interface BrokerStatus {
  readonly broker: BrokerId;
  readonly connected: boolean;
  readonly needsReauth: boolean;
  readonly accessExpiresAt?: number;
  readonly refreshExpiresAt?: number;
  readonly reason?: string;
}

/**
 * One principal's live connection to one broker.
 *
 * Instances are request-scoped. They must never be cached at module scope:
 * a Lambda container is reused across invocations, so a token held in module
 * or instance state outlives the request that fetched it and would authorize
 * the *next* user's call with the previous user's credential.
 */
export interface BrokerConnection {
  readonly broker: BrokerId;
  readonly principal: string;
  authorize(req: OutboundRequest): Promise<AuthorizedRequest>;
  status(): Promise<BrokerStatus>;
}
