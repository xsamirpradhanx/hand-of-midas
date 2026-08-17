import fs from 'fs';
import os from 'os';
import path from 'path';

export interface RedditSentiment {
  mentions: number;
  sentimentScore: number; // -1 to 1
  trending: boolean;
  topPosts: Array<{
    title: string;
    score: number;
    url: string;
  }>;
}

interface DevvitTokenPayload {
  refreshToken: string;
  accessToken: string;
  expiresAt: number; // epoch ms
  scope: string;
  tokenType: string;
}

const TOKEN_PATH = path.join(os.homedir(), '.devvit', 'token');
// Refresh a little early so a request never races an expiry mid-flight.
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

function readTokenFile(): DevvitTokenPayload | null {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    if (!raw.token) return null;
    return JSON.parse(Buffer.from(raw.token, 'base64').toString('utf8')) as DevvitTokenPayload;
  } catch (error) {
    console.error('[Reddit Service] Failed to parse Devvit token:', error);
    return null;
  }
}

function writeTokenFile(payload: DevvitTokenPayload): void {
  try {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ token: encoded, copyPaste: false }), 'utf8');
  } catch (error) {
    // Non-fatal: the refreshed token still works for this process even if
    // persisting it to disk fails, just won't survive a restart.
    console.warn('[Reddit Service] Failed to persist refreshed Devvit token:', error);
  }
}

/** Reddit's OAuth client_id is embedded in the access token's JWT payload (`cid` claim). */
function extractClientId(accessToken: string): string | null {
  try {
    const segment = accessToken.split('.')[1];
    if (!segment) return null;
    const padded = segment + '='.repeat((4 - (segment.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8'));
    return payload.cid ?? null;
  } catch {
    return null;
  }
}

async function refreshAccessToken(current: DevvitTokenPayload): Promise<DevvitTokenPayload | null> {
  const clientId = extractClientId(current.accessToken);
  if (!clientId) {
    console.warn('[Reddit Service] Could not determine OAuth client_id from cached token; cannot refresh.');
    return null;
  }

  try {
    const response = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${clientId}:`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'HandOfMidas/1.0',
      },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(current.refreshToken)}`,
    });

    if (!response.ok) {
      console.error(`[Reddit Service] Token refresh failed: ${response.status} ${response.statusText}. Re-run "devvit login" to reauthorize.`);
      return null;
    }

    const body = await response.json() as { access_token: string; expires_in: number; refresh_token?: string; scope: string; token_type: string };
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? current.refreshToken,
      expiresAt: Date.now() + body.expires_in * 1000,
      scope: body.scope,
      tokenType: body.token_type,
    };
  } catch (error) {
    console.error('[Reddit Service] Error refreshing Devvit token:', error);
    return null;
  }
}

/**
 * Returns a valid Reddit OAuth access token, transparently refreshing the
 * cached Devvit token (~/.devvit/token) via its refresh_token when expired.
 */
async function getValidRedditAccessToken(): Promise<string | null> {
  const cached = readTokenFile();
  if (!cached) {
    console.warn('[Reddit Service] No Devvit token found. Run "devvit login" to authorize Reddit access.');
    return null;
  }

  if (cached.expiresAt > Date.now() + EXPIRY_SAFETY_MARGIN_MS) {
    return cached.accessToken;
  }

  const refreshed = await refreshAccessToken(cached);
  if (!refreshed) return null;

  writeTokenFile(refreshed);
  return refreshed.accessToken;
}

/**
 * Fetches recent posts from r/wallstreetbets for the given symbol and analyzes sentiment.
 */
export async function getRedditSentiment(symbol: string): Promise<RedditSentiment> {
  const defaultRes: RedditSentiment = {
    mentions: 0,
    sentimentScore: 0,
    trending: false,
    topPosts: []
  };

  const token = await getValidRedditAccessToken();
  if (!token) {
    return defaultRes;
  }

  try {
    const query = encodeURIComponent(symbol);
    const url = `https://oauth.reddit.com/r/wallstreetbets/search?q=${query}&restrict_sr=1&sort=new&limit=25`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'HandOfMidas/1.0'
      }
    });

    if (!response.ok) {
      console.warn(`[Reddit Service] API returned ${response.status} for ${symbol}`);
      return defaultRes;
    }

    const data = await response.json() as { data?: { children?: Array<{ data: any }> } };
    const children = data?.data?.children || [];

    if (children.length === 0) {
      return defaultRes;
    }

    let bullScore = 0;
    let bearScore = 0;
    let totalScoreAndComments = 0;

    const bullishWords = ['call', 'calls', 'moon', 'bull', 'buy', 'yolo', 'gain', 'profit', 'up', 'beat', 'rocket'];
    const bearishWords = ['put', 'puts', 'bear', 'sell', 'loss', 'guh', 'down', 'miss', 'crash', 'drop', 'dump'];

    const topPosts = [];

    for (const child of children) {
      const post = child.data;
      const text = `${post.title || ''} ${post.selftext || ''}`.toLowerCase();

      let postBull = 0;
      let postBear = 0;

      for (const w of bullishWords) if (text.includes(w)) postBull++;
      for (const w of bearishWords) if (text.includes(w)) postBear++;

      bullScore += postBull;
      bearScore += postBear;
      totalScoreAndComments += (post.score || 0) + (post.num_comments || 0);

      // Save top 3 highly upvoted posts
      if (topPosts.length < 3) {
        topPosts.push({
          title: post.title,
          score: post.score,
          url: `https://reddit.com${post.permalink}`
        });
      }
    }

    // Sort the top posts by score descending
    topPosts.sort((a, b) => b.score - a.score);

    const netScore = bullScore - bearScore;
    const totalSentimentTokens = bullScore + bearScore;

    let sentimentScore = 0;
    if (totalSentimentTokens > 0) {
      sentimentScore = netScore / totalSentimentTokens; // -1 to 1
    }

    // Rough trending heuristic based on total engagement on recent posts
    const trending = children.length >= 10 && totalScoreAndComments > 500;

    return {
      mentions: children.length, // Number of posts returned in the limit window
      sentimentScore,
      trending,
      topPosts: topPosts.slice(0, 3)
    };
  } catch (error) {
    console.error(`[Reddit Service] Error fetching data for ${symbol}:`, error);
    return defaultRes;
  }
}
