import fs from 'fs';
import path from 'path';

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

const TOKEN_PATH = path.join(process.cwd(), '.schwab_token.json');
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
      throw new Error(`Failed to refresh token: ${response.status} ${errorText}`);
    }

    const tokenData = await response.json() as SchwabTokenInfo;
    tokenData.timestamp = Date.now();
    this.saveToken(tokenData);
    return tokenData;
  }

  saveToken(tokenInfo: SchwabTokenInfo) {
    this.currentToken = tokenInfo;
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
        console.error('Failed to refresh token', e);
        return null;
      }
    }

    return tokenInfo.access_token;
  }
}
