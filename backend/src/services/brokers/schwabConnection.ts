/**
 * Schwab OAuth 2.0 connection, scoped to one principal for one request.
 *
 * Replaces the module-level `const auth = new SchwabAuth()` singletons in
 * schwabService.ts and marketData/schwabHistory.ts. Those cached the first
 * token loaded into a container in instance state, and because a Lambda
 * execution environment is reused across invocations, the *next* invocation —
 * a different user — would be authorized with the previous user's credential.
 * The same applied in reverse to the module-level revoked flag: one dead
 * credential disabled Schwab for every principal sharing the container.
 *
 * Nothing here is cached beyond the lifetime of the instance, and an instance
 * belongs to exactly one principal.
 */
import {
  TokenConflictError,
  type BrokerConnection,
  type BrokerStatus,
  type BrokerTokenStore,
  type OutboundRequest,
  type AuthorizedRequest,
  type StoredBrokerToken,
} from './types.js';

const SCHWAB_AUTH_URL = 'https://api.schwabapi.com/v1/oauth/authorize';
const SCHWAB_TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';

/** Refresh this far before expiry so a request never races the boundary. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export class SchwabRefreshRevokedError extends Error {
  constructor(readonly principal: string) {
    super(
      'Schwab refresh token is expired or revoked. Refresh grants last 7 days and ' +
        'cannot be renewed automatically — the account must be re-authorized.',
    );
    this.name = 'SchwabRefreshRevokedError';
  }
}

export class SchwabConnection implements BrokerConnection {
  readonly broker = 'schwab' as const;

  private readonly clientId = process.env['SCHWAB_CLIENT_ID'] ?? '';
  private readonly clientSecret = process.env['SCHWAB_CLIENT_SECRET'] ?? '';
  private readonly redirectUri = process.env['SCHWAB_REDIRECT_URI'] ?? 'https://127.0.0.1';

  constructor(
    readonly principal: string,
    private readonly store: BrokerTokenStore,
  ) {}

  private get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  private basicAuth(): string {
    return Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
  }

  /** Browser URL that begins authorization for this principal. */
  authorizeUrl(state: string): string {
    const q = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      state,
    });
    return `${SCHWAB_AUTH_URL}?${q.toString()}`;
  }

  /** Exchange an authorization code for the initial token pair. */
  async completeAuthorization(code: string): Promise<StoredBrokerToken> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
    });
    const raw = await this.postToken(body);
    return this.persist(raw, undefined);
  }

  private async postToken(body: URLSearchParams): Promise<any> {
    const res = await fetch(SCHWAB_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${this.basicAuth()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      // Schwab nests the real reason inside a doubly-encoded error_description,
      // so match the substring rather than trying to parse it.
      if (text.includes('invalid_grant') || text.includes('expired or revoked')) {
        await this.store.markRevoked(this.principal, this.broker);
        throw new SchwabRefreshRevokedError(this.principal);
      }
      throw new Error(`Schwab token request failed: ${res.status} ${text}`);
    }
    return JSON.parse(text);
  }

  private async persist(raw: any, expectedVersion: number | undefined): Promise<StoredBrokerToken> {
    const now = Date.now();
    return this.store.save(
      this.principal,
      this.broker,
      {
        broker: this.broker,
        accessToken: raw.access_token,
        refreshToken: raw.refresh_token,
        accessExpiresAt: now + (raw.expires_in ?? 1800) * 1000,
        refreshExpiresAt: now + (raw.refresh_token_expires_in ?? 7 * 24 * 60 * 60) * 1000,
        scope: raw.scope,
      },
      expectedVersion,
    );
  }

  /**
   * A usable access token, refreshing if needed.
   *
   * Returns null when this principal has no connection at all — an ordinary
   * state that callers handle by falling back to another provider. Throws
   * SchwabRefreshRevokedError when a connection exists but is dead, because
   * that needs surfacing to the user rather than silent degradation.
   */
  async getAccessToken(): Promise<string | null> {
    if (!this.configured) return null;

    const stored = await this.store.load(this.principal, this.broker);
    if (!stored) return null;
    if (stored.revokedAt) throw new SchwabRefreshRevokedError(this.principal);

    if (stored.accessExpiresAt - REFRESH_SKEW_MS > Date.now()) return stored.accessToken;

    if (stored.refreshExpiresAt <= Date.now()) {
      await this.store.markRevoked(this.principal, this.broker);
      throw new SchwabRefreshRevokedError(this.principal);
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
    });

    try {
      const raw = await this.postToken(body);
      const saved = await this.persist(raw, stored.version);
      return saved.accessToken;
    } catch (err) {
      if (err instanceof TokenConflictError) {
        // Another invocation refreshed first. Its token is the valid one —
        // retrying our own refresh could invalidate theirs, so re-read.
        const fresh = await this.store.load(this.principal, this.broker);
        if (fresh && !fresh.revokedAt && fresh.accessExpiresAt > Date.now()) {
          return fresh.accessToken;
        }
      }
      throw err;
    }
  }

  async authorize(req: OutboundRequest): Promise<AuthorizedRequest> {
    const token = await this.getAccessToken();
    if (!token) throw new Error(`No Schwab connection for principal ${this.principal}`);
    const url = req.params ? `${req.url}?${new URLSearchParams(req.params)}` : req.url;
    return { url, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } };
  }

  async status(): Promise<BrokerStatus> {
    if (!this.configured) {
      return {
        broker: this.broker,
        connected: false,
        needsReauth: false,
        reason: 'Schwab client credentials are not configured on the server.',
      };
    }
    const stored = await this.store.load(this.principal, this.broker);
    if (!stored) {
      return { broker: this.broker, connected: false, needsReauth: true, reason: 'Not connected.' };
    }
    const dead = Boolean(stored.revokedAt) || stored.refreshExpiresAt <= Date.now();
    return {
      broker: this.broker,
      connected: !dead,
      needsReauth: dead,
      accessExpiresAt: stored.accessExpiresAt,
      refreshExpiresAt: stored.refreshExpiresAt,
      reason: dead ? 'Refresh grant expired or revoked; re-authorization required.' : undefined,
    };
  }
}
