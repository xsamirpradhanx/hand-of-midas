import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api';
import styles from './SentimentDashboard.module.css';

interface StocktwitsMessage {
  id: number;
  body: string;
  created_at: string;
  user: {
    username: string;
    avatar_url: string;
    followers: number;
    ideas: number;
  };
  entities?: {
    sentiment?: {
      basic: 'Bullish' | 'Bearish';
    };
  };
}

interface SentimentData {
  symbol: string;
  retail: {
    bullish: number;
    bearish: number;
    ratio: number;
    watchlistCount: number;
    volumeChange: number;
    sentimentChange: number;
    messages: StocktwitsMessage[];
  };
  reddit: {
    mentions: number;
    sentimentScore: number;
    trending: boolean;
    topPosts: Array<{
      title: string;
      score: number;
      url: string;
    }>;
  };
  finnhub: {
    insiderSentiment: number;
    newsSentiment: number;
    buzz: number;
  };
  news: {
    score: number;
    bias: 'bullish' | 'bearish' | 'neutral';
    bullCount: number;
    bearCount: number;
    articles: {
      title: string;
      url: string;
      published_utc: string;
      source: string;
    }[];
  };
  timestamp: string;
}

export const SentimentDashboard: React.FC = () => {
  const [symbol, setSymbol] = useState(() => {
    try {
      const stored = window.localStorage.getItem('dashboard_selectedSymbol');
      return stored ? JSON.parse(stored) : 'SPY';
    } catch {
      return 'SPY';
    }
  });

  const [data, setData] = useState<SentimentData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSentiment = useCallback(async (sym: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/sentiment/${sym}`);
      if (!response.ok) {
        throw new Error('Failed to load sentiment data');
      }
      const result = await response.json();
      setData(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSentiment(symbol);
  }, [symbol, fetchSentiment]);

  useEffect(() => {
    const handleTickerSelected = (e: CustomEvent<{ symbol: string }>) => {
      setSymbol(e.detail.symbol.toUpperCase());
    };
    window.addEventListener('TICKER_SELECTED', handleTickerSelected as EventListener);
    return () => window.removeEventListener('TICKER_SELECTED', handleTickerSelected as EventListener);
  }, []);

  if (loading && !data) {
    return <div className={styles.loading}>Loading sentiment data...</div>;
  }

  if (error) {
    return <div className={styles.error}>{error}</div>;
  }

  if (!data) return null;

  const totalRetail = data.retail.bullish + data.retail.bearish;
  const retailBullPct = totalRetail > 0 ? (data.retail.bullish / totalRetail) * 100 : 50;

  const totalNews = data.news.bullCount + data.news.bearCount;
  const newsBullPct = totalNews > 0 ? (data.news.bullCount / totalNews) * 100 : 50;

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>{symbol} Sentiment Overview</h1>
      
      <div className={styles.gaugesContainer}>
        <div className={styles.gaugeCard}>
          <h3>Retail Sentiment (Stocktwits)</h3>
          <div className={styles.gaugeVisual}>
            <div className={styles.gaugeFill} style={{ width: `${retailBullPct}%` }} />
          </div>
          <div className={styles.gaugeLabels}>
            <span className={styles.bearLabel}>Bearish ({data.retail.bearish})</span>
            <span className={styles.bullLabel}>Bullish ({data.retail.bullish})</span>
          </div>
          <p className={styles.summaryText}>
            {retailBullPct > 60 ? 'Strongly Bullish' : retailBullPct < 40 ? 'Strongly Bearish' : 'Neutral'}
          </p>
          <div className={styles.retailMeta}>
            <div className={styles.metaItem}>
              <span>Watchers</span>
              <strong>{data.retail.watchlistCount.toLocaleString()}</strong>
            </div>
            <div className={styles.metaItem}>
              <span>Vol Change</span>
              <strong className={data.retail.volumeChange >= 0 ? styles.up : styles.down}>
                {data.retail.volumeChange >= 0 ? '+' : ''}{data.retail.volumeChange}%
              </strong>
            </div>
            <div className={styles.metaItem}>
              <span>Sent Change</span>
              <strong className={data.retail.sentimentChange >= 0 ? styles.up : styles.down}>
                {data.retail.sentimentChange >= 0 ? '+' : ''}{data.retail.sentimentChange}%
              </strong>
            </div>
          </div>
        </div>

        <div className={styles.gaugeCard}>
          <h3>Institutional & News Sentiment</h3>
          <div className={styles.gaugeVisual}>
            <div className={styles.gaugeFill} style={{ width: `${newsBullPct}%` }} />
          </div>
          <div className={styles.gaugeLabels}>
            <span className={styles.bearLabel}>Negative Keywords</span>
            <span className={styles.bullLabel}>Positive Keywords</span>
          </div>
          <p className={styles.summaryText}>
            {data.news.bias === 'bullish' ? 'Bullish' : data.news.bias === 'bearish' ? 'Bearish' : 'Neutral'} ({data.news.score.toFixed(2)})
          </p>
        </div>

        {/* Reddit Sentiment */}
        <div className={styles.gaugeCard}>
          <h3>Reddit (r/WSB) Sentiment</h3>
          <div className={styles.gaugeVisual}>
            <div className={styles.gaugeFill} style={{ width: `${(data.reddit.sentimentScore + 1) * 50}%` }} />
          </div>
          <div className={styles.gaugeLabels}>
            <span className={styles.bearLabel}>Bearish</span>
            <span className={styles.bullLabel}>Bullish</span>
          </div>
          <p className={styles.summaryText}>
            {data.reddit.sentimentScore > 0.2 ? 'Bullish' : data.reddit.sentimentScore < -0.2 ? 'Bearish' : 'Neutral'}
          </p>
          <div className={styles.retailMeta}>
            <div className={styles.metaItem}>
              <span>Mentions</span>
              <strong>{data.reddit.mentions}</strong>
            </div>
            <div className={styles.metaItem}>
              <span>Trending</span>
              <strong className={data.reddit.trending ? styles.up : styles.down}>
                {data.reddit.trending ? 'Yes 🔥' : 'No'}
              </strong>
            </div>
          </div>
        </div>

        {/* Finnhub Sentiment */}
        <div className={styles.gaugeCard}>
          <h3>Insider Sentiment (Finnhub)</h3>
          <div className={styles.gaugeVisual}>
            <div className={styles.gaugeFill} style={{ width: `${data.finnhub.insiderSentiment}%` }} />
          </div>
          <div className={styles.gaugeLabels}>
            <span className={styles.bearLabel}>Selling</span>
            <span className={styles.bullLabel}>Buying</span>
          </div>
          <p className={styles.summaryText}>
            {data.finnhub.insiderSentiment > 60 ? 'Net Buying' : data.finnhub.insiderSentiment < 40 ? 'Net Selling' : 'Neutral'}
          </p>
          <div className={styles.retailMeta}>
            <div className={styles.metaItem}>
              <span>News Sent</span>
              <strong>{data.finnhub.newsSentiment}/100</strong>
            </div>
            <div className={styles.metaItem}>
              <span>Buzz</span>
              <strong>{(data.finnhub.buzz * 100).toFixed(0)}%</strong>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.feedContainer}>
        <div className={styles.feedSection}>
          <h2>Retail Chatter (Live)</h2>
          <div className={styles.messagesList}>
            {data.retail.messages.map(msg => (
              <div key={msg.id} className={styles.messageCard}>
                <div className={styles.messageHeader}>
                  <img src={msg.user.avatar_url} alt={msg.user.username} className={styles.avatar} />
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span className={styles.username}>@{msg.user.username}</span>
                    <span className={styles.followers}>{msg.user.followers.toLocaleString()} followers</span>
                  </div>
                  {msg.entities?.sentiment?.basic && (
                    <span className={`${styles.sentimentBadge} ${msg.entities.sentiment.basic === 'Bullish' ? styles.badgeBull : styles.badgeBear}`}>
                      {msg.entities.sentiment.basic}
                    </span>
                  )}
                </div>
                <p className={styles.messageBody}>{msg.body}</p>
                <span className={styles.timestamp}>{new Date(msg.created_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.feedSection}>
          <h2>Recent Headlines</h2>
          <div className={styles.articlesList}>
            {data.news.articles.map((article, idx) => (
              <a key={idx} href={article.url} target="_blank" rel="noopener noreferrer" className={styles.articleCard}>
                <div className={styles.articleHeader}>
                  <span className={styles.source}>{article.source}</span>
                  <span className={styles.timestamp}>{new Date(article.published_utc).toLocaleString()}</span>
                </div>
                <h3 className={styles.articleTitle}>{article.title}</h3>
              </a>
            ))}
          </div>
        </div>
        <div className={styles.feedSection}>
          <h2>Reddit Top Posts</h2>
          <div className={styles.articlesList}>
            {data.reddit.topPosts.map((post, idx) => (
              <a key={idx} href={post.url} target="_blank" rel="noopener noreferrer" className={styles.articleCard}>
                <div className={styles.articleHeader}>
                  <span className={styles.source}>r/wallstreetbets</span>
                  <span className={styles.timestamp}>Score: {post.score}</span>
                </div>
                <h3 className={styles.articleTitle}>{post.title}</h3>
              </a>
            ))}
            {data.reddit.topPosts.length === 0 && (
              <div className={styles.messageBody} style={{ padding: '20px', textAlign: 'center', color: '#888' }}>
                No recent highly upvoted posts.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SentimentDashboard;
