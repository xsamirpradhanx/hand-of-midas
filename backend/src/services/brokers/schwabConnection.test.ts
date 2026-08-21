import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SchwabConnection, SchwabRefreshRevokedError } from './schwabConnection.js';
import { TokenConflictError, type BrokerId, type BrokerTokenStore, type NewBrokerToken, type StoredBrokerToken } from './types.js';

/** In-memory store; mirrors the conditional-write semantics of the Dynamo one. */
class FakeStore implements BrokerTokenStore {
  items = new Map<string, StoredBrokerToken>();
  saves: string[] = [];
  private key = (p: string, b: BrokerId) => `${p}/${b}`;

  async load(p: string, b: BrokerId) { return this.items.get(this.key(p, b)) ?? null; }

  async save(p: string, b: BrokerId, t: NewBrokerToken, expectedVersion?: number) {
    const existing = this.items.get(this.key(p, b));
    if (expectedVersion !== undefined && (existing?.version ?? 0) !== expectedVersion) {
      throw new TokenConflictError(p, b);
    }
    const saved: StoredBrokerToken = { ...t, version: (expectedVersion ?? 0) + 1 };
    this.items.set(this.key(p, b), saved);
    this.saves.push(p);
    return saved;
  }

  async markRevoked(p: string, b: BrokerId) {
    const e = this.items.get(this.key(p, b));
    if (e) this.items.set(this.key(p, b), { ...e, revokedAt: Date.now() });
  }
  async clear(p: string, b: BrokerId) { this.items.delete(this.key(p, b)); }
}

const HOUR = 60 * 60 * 1000;
function token(over: Partial<StoredBrokerToken> = {}): StoredBrokerToken {
  return {
    broker: 'schwab', accessToken: 'access', refreshToken: 'refresh',
    accessExpiresAt: Date.now() + HOUR, refreshExpiresAt: Date.now() + 7 * 24 * HOUR,
    version: 1, ...over,
  };
}

describe('SchwabConnection', () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
    process.env['SCHWAB_CLIENT_ID'] = 'id';
    process.env['SCHWAB_CLIENT_SECRET'] = 'secret';
  });
  afterEach(() => vi.restoreAllMocks());

  it('never serves one principal the token of another', async () => {
    store.items.set('alice/schwab', token({ accessToken: 'ALICE' }));
    store.items.set('bob/schwab', token({ accessToken: 'BOB' }));

    // Interleaved, mimicking a warm container reused across invocations.
    expect(await new SchwabConnection('alice', store).getAccessToken()).toBe('ALICE');
    expect(await new SchwabConnection('bob', store).getAccessToken()).toBe('BOB');
    expect(await new SchwabConnection('alice', store).getAccessToken()).toBe('ALICE');
  });

  it('returns null — not another principal\'s token — when unconnected', async () => {
    store.items.set('alice/schwab', token({ accessToken: 'ALICE' }));
    expect(await new SchwabConnection('alice', store).getAccessToken()).toBe('ALICE');
    expect(await new SchwabConnection('carol', store).getAccessToken()).toBeNull();
  });

  it('one principal\'s revoked grant does not disable another', async () => {
    store.items.set('alice/schwab', token({ revokedAt: Date.now() }));
    store.items.set('bob/schwab', token({ accessToken: 'BOB' }));

    await expect(new SchwabConnection('alice', store).getAccessToken())
      .rejects.toBeInstanceOf(SchwabRefreshRevokedError);
    expect(await new SchwabConnection('bob', store).getAccessToken()).toBe('BOB');
  });

  it('refreshes an expired access token and stores the new pair', async () => {
    store.items.set('alice/schwab', token({ accessExpiresAt: Date.now() - 1000 }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ access_token: 'NEW', refresh_token: 'NEWREF', expires_in: 1800 }),
      { status: 200 },
    )));

    expect(await new SchwabConnection('alice', store).getAccessToken()).toBe('NEW');
    expect(store.items.get('alice/schwab')!.accessToken).toBe('NEW');
  });

  it('adopts the winner\'s token when it loses a concurrent refresh', async () => {
    store.items.set('alice/schwab', token({ accessExpiresAt: Date.now() - 1000, version: 1 }));
    vi.stubGlobal('fetch', vi.fn(async () => {
      // Another invocation refreshes and bumps the version mid-flight.
      store.items.set('alice/schwab', token({ accessToken: 'WINNER', version: 2 }));
      return new Response(
        JSON.stringify({ access_token: 'LOSER', refresh_token: 'r', expires_in: 1800 }),
        { status: 200 },
      );
    }));

    expect(await new SchwabConnection('alice', store).getAccessToken()).toBe('WINNER');
    expect(store.items.get('alice/schwab')!.accessToken).toBe('WINNER');
  });

  it('marks revoked on invalid_grant instead of retrying forever', async () => {
    store.items.set('alice/schwab', token({ accessExpiresAt: Date.now() - 1000 }));
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'expired or revoked' }),
      { status: 400 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const conn = new SchwabConnection('alice', store);
    await expect(conn.getAccessToken()).rejects.toBeInstanceOf(SchwabRefreshRevokedError);
    expect(store.items.get('alice/schwab')!.revokedAt).toBeDefined();

    // Second call must short-circuit on stored state, not hit Schwab again.
    await expect(new SchwabConnection('alice', store).getAccessToken())
      .rejects.toBeInstanceOf(SchwabRefreshRevokedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not attempt refresh once the grant window has passed', async () => {
    store.items.set('alice/schwab', token({
      accessExpiresAt: Date.now() - 1000, refreshExpiresAt: Date.now() - 1000,
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new SchwabConnection('alice', store).getAccessToken())
      .rejects.toBeInstanceOf(SchwabRefreshRevokedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports status without throwing for an unconnected principal', async () => {
    const s = await new SchwabConnection('dave', store).status();
    expect(s).toMatchObject({ broker: 'schwab', connected: false, needsReauth: true });
  });
});
