/**
 * DynamoDB-backed broker credential storage.
 *
 * Keyed into the existing single table alongside alerts and chart configs:
 *
 *   pk = USER#<cognito-sub>  |  USER#SYSTEM
 *   sk = BROKER#SCHWAB       |  BROKER#ETRADE
 *
 * The filesystem store this replaces cannot work in Lambda — the filesystem is
 * read-only outside /tmp, and /tmp is per-container, so a token written by one
 * invocation is invisible to the next container and lost on scale-in.
 */
import { getItem, putItem, deleteItem } from '../dynamodb.js';
import { getCipher } from './cipher.js';
import {
  TokenConflictError,
  type BrokerId,
  type BrokerTokenStore,
  type NewBrokerToken,
  type StoredBrokerToken,
} from './types.js';

interface BrokerTokenItem {
  pk: string;
  sk: string;
  broker: BrokerId;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  tokenSecretEnc?: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  scope?: string;
  revokedAt?: number;
  version: number;
  updatedAt: string;
}

const pkFor = (principal: string) => `USER#${principal}`;
const skFor = (broker: BrokerId) => `BROKER#${broker.toUpperCase()}`;

/** DynamoDB signals a lost optimistic-lock race with this error name. */
function isConditionalCheckFailure(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'ConditionalCheckFailedException';
}

export class DynamoBrokerTokenStore implements BrokerTokenStore {
  async load(principal: string, broker: BrokerId): Promise<StoredBrokerToken | null> {
    const item = await getItem<BrokerTokenItem>(pkFor(principal), skFor(broker));
    if (!item) return null;

    const cipher = getCipher();
    const [accessToken, refreshToken, tokenSecret] = await Promise.all([
      cipher.decrypt(item.accessTokenEnc),
      cipher.decrypt(item.refreshTokenEnc),
      item.tokenSecretEnc ? cipher.decrypt(item.tokenSecretEnc) : Promise.resolve(undefined),
    ]);

    return {
      broker: item.broker,
      accessToken,
      refreshToken,
      tokenSecret,
      accessExpiresAt: item.accessExpiresAt,
      refreshExpiresAt: item.refreshExpiresAt,
      scope: item.scope,
      revokedAt: item.revokedAt,
      version: item.version,
    };
  }

  async save(
    principal: string,
    broker: BrokerId,
    token: NewBrokerToken,
    expectedVersion?: number,
  ): Promise<StoredBrokerToken> {
    const cipher = getCipher();
    const [accessTokenEnc, refreshTokenEnc, tokenSecretEnc] = await Promise.all([
      cipher.encrypt(token.accessToken),
      cipher.encrypt(token.refreshToken),
      token.tokenSecret ? cipher.encrypt(token.tokenSecret) : Promise.resolve(undefined),
    ]);

    const nextVersion = (expectedVersion ?? 0) + 1;
    const item: BrokerTokenItem = {
      pk: pkFor(principal),
      sk: skFor(broker),
      broker,
      accessTokenEnc,
      refreshTokenEnc,
      tokenSecretEnc,
      accessExpiresAt: token.accessExpiresAt,
      refreshExpiresAt: token.refreshExpiresAt,
      scope: token.scope,
      version: nextVersion,
      updatedAt: new Date().toISOString(),
      // A successful write always clears a prior revocation: the only way to
      // produce a fresh token is a working grant.
      revokedAt: undefined,
    };

    try {
      await putItem(item, expectedVersion);
    } catch (err) {
      if (isConditionalCheckFailure(err)) throw new TokenConflictError(principal, broker);
      throw err;
    }

    return { ...token, version: nextVersion };
  }

  async markRevoked(principal: string, broker: BrokerId): Promise<void> {
    const existing = await getItem<BrokerTokenItem>(pkFor(principal), skFor(broker));
    if (!existing) return;
    // Deliberately unconditional. This is a terminal state that must stick even
    // if it races another writer — losing the race would leave every container
    // retrying a grant the provider has already rejected.
    await putItem({ ...existing, revokedAt: Date.now(), updatedAt: new Date().toISOString() });
  }

  async clear(principal: string, broker: BrokerId): Promise<void> {
    await deleteItem(pkFor(principal), skFor(broker));
  }
}
