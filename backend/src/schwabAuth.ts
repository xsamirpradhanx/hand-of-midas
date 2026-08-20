import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface SchwabTokenInfo {
  access_token: string;
  refresh_token: string;
  id_token: string;
  expires_in: number;
  refresh_token_expires_in: number;
  token_type: string;
  scope: string;
  timestamp?: number;
}

/**
 * Token location, resolved robustly rather than from process.cwd() alone.
 *
 * cwd differs by entry point — `npm run dev --workspace=backend` starts at the repo
 * root while `tsx src/scripts/*.ts` starts in backend/ — so a cwd-only path silently
 * looked for the token in a directory that never had it and reported "not
 * authenticated" on a perfectly good token file.
 *
 * Order: explicit env override, then cwd (backward compatible), then the backend
 * package root derived from this module's own location.
 */
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_CANDIDATES = [
  process.env.SCHWAB_TOKEN_PATH,
  path.join(process.cwd(), '.schwab_token.json'),
  path.join(MODULE_ROOT, '.schwab_token.json'),
].filter((p): p is string => typeof p === 'string' && p.length > 0);

function resolveTokenPath(): string {
  return TOKEN_CANDIDATES.find(p => fs.existsSync(p)) ?? TOKEN_CANDIDATES[TOKEN_CANDIDATES.length - 1];
}

const TOKEN_PATH = resolveTokenPath();

/**
 * Latched once Schwab rejects the refresh token with invalid_grant.
 *
 * That error is terminal: refresh tokens carry a hard 7-day life and cannot be
 * renewed programmatically — only a browser re-authorization mints a new one.
 * Without this latch every subsequent quote and options call fired its own doomed
 * POST to Schwab and logged a full stack trace, which on one screener pass meant
 * hundreds of pointless round-trips and a log so noisy that real errors were buried.
 * Cleared by saveToken() when a fresh token arrives.
 */
let refreshTokenRevoked = false;
const SCHWAB_AUTH_URL = 'https://api.schwabapi.com/v1/oauth/authorize';
const SCHWAB_TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';

export class SchwabAuth {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  private currentToken: SchwabTokenInfo | null = null;
  
  constructor() {
    this.clientId = process.env.SCHWAB_CLIENT_ID || '';
    this.clientSecret = process.env.SCHWAB_CLIENT_SECRET || '';
    this.redirectUri = process.env.SCHWAB_REDIRECT_URI || 'https://127.0.0.1';
    
    if (!this.clientId || !this.clientSecret) {
      console.warn('⚠️ SCHWAB_CLIENT_ID or SCHWAB_CLIENT_SECRET is missing from environment variables.');
    }
  }

  getAuthUrl(): string {
    return `${SCHWAB_AUTH_URL}?client_id=${this.clientId}&redirect_uri=${encodeURIComponent(this.redirectUri)}`;
  }

  async getAccessTokenFromCode(code: string): Promise<SchwabTokenInfo> {
    const authHeader = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    
    const body = new URLSearchParams();
    body.append('grant_type', 'authorization_code');
    body.append('code', code);
    body.append('redirect_uri', this.redirectUri);

    const response = await fetch(SCHWAB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get access token: ${response.status} ${errorText}`);
    }

    const tokenData = await response.json() as SchwabTokenInfo;
    tokenData.timestamp = Date.now();
    this.saveToken(tokenData);
    return tokenData;
  }

  async refreshAccessToken(refreshToken: string): Promise<SchwabTokenInfo> {
    const authHeader = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    
    const body = new URLSearchParams();
    body.append('grant_type', 'refresh_token');
    body.append('refresh_token', refreshToken);

    const response = await fetch(SCHWAB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });

    if (!response.ok) {
      const errorText = await response.text();
      // Schwab nests the real reason inside error_description, so match on the
      // substring rather than trying to parse a doubly-encoded body.
      if (errorText.includes('invalid_grant') || errorText.includes('expired or revoked')) {
        refreshTokenRevoked = true;
        console.error(
          '\n❌ Schwab refresh token is expired or revoked — Schwab data is unavailable.\n' +
          '   Refresh tokens last 7 days and cannot be renewed automatically.\n' +
          '   Re-authorize with:  npm run schwab-auth --workspace=backend\n' +
          '   All providers fall back to Yahoo until then.\n',
        );
      }
      throw new Error(`Failed to refresh token: ${response.status} ${errorText}`);
    }

    const tokenData = await response.json() as SchwabTokenInfo;
    tokenData.timestamp = Date.now();
    this.saveToken(tokenData);
    return tokenData;
  }

  saveToken(tokenInfo: SchwabTokenInfo) {
    this.currentToken = tokenInfo;
    refreshTokenRevoked = false;
    try {
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokenInfo, null, 2), 'utf-8');
    } catch (e) {
      console.warn('⚠️ Could not save Schwab token to file. Token will remain in memory only.');
    }
  }

  loadToken(): SchwabTokenInfo | null {
    if (this.currentToken) {
      return this.currentToken;
    }

    if (fs.existsSync(TOKEN_PATH)) {
      try {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
        this.currentToken = token;
        return token;
      } catch (e) {
        console.error('Failed to parse saved token', e);
      }
    }

    // Support for serverless/deployed environments where the file isn't present
    if (process.env.SCHWAB_REFRESH_TOKEN) {
      const token: SchwabTokenInfo = {
        access_token: '',
        refresh_token: process.env.SCHWAB_REFRESH_TOKEN,
        id_token: '',
        expires_in: 0,
        refresh_token_expires_in: 0,
        token_type: 'Bearer',
        scope: '',
        timestamp: 0 // Force immediate refresh
      };
      this.currentToken = token;
      return token;
    }

    return null;
  }

  async getValidAccessToken(): Promise<string | null> {
    // Already known dead — fail fast instead of issuing another doomed request.
    if (refreshTokenRevoked) return null;

    const tokenInfo = this.loadToken();
    if (!tokenInfo) return null;

    const now = Date.now();
    // access_token typically expires in 1800 seconds (30 minutes).
    // Let's refresh if it's older than 25 minutes (1500 seconds).
    const elapsedSeconds = (now - (tokenInfo.timestamp || 0)) / 1000;
    
    if (elapsedSeconds > 1500) {
      console.log('Access token expired or expiring soon, refreshing...');
      try {
        const newTokenInfo = await this.refreshAccessToken(tokenInfo.refresh_token);
        return newTokenInfo.access_token;
      } catch (e) {
        // The terminal invalid_grant case has already printed a single actionable
        // message in refreshAccessToken(); repeating the stack per call buries it.
        if (!refreshTokenRevoked) console.error('Failed to refresh token', e);
        this.currentToken = null; // Clear from memory so it can read from disk next time
        return null;
      }
    }

    return tokenInfo.access_token;
  }
}
