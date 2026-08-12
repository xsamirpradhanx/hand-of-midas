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

/**
 * Attempts to read the Devvit OAuth token from the local filesystem.
 */
function getRedditToken(): string | null {
  try {
    const tokenPath = path.join(os.homedir(), '.devvit', 'token');
    if (!fs.existsSync(tokenPath)) {
      return null;
    }
    const data = fs.readFileSync(tokenPath, 'utf8');
    const parsed = JSON.parse(data);
    
    if (parsed.token) {
      const decoded = Buffer.from(parsed.token, 'base64').toString('utf8');
      const tokenObj = JSON.parse(decoded);
      return tokenObj.accessToken || null;
    }
    return null;
  } catch (error) {
    console.error('[Reddit Service] Failed to parse Devvit token:', error);
    return null;
  }
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

  const token = getRedditToken();
  if (!token) {
    console.warn(`[Reddit Service] No Devvit token found. Reddit data will be empty for ${symbol}.`);
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

    const data = await response.json();
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
