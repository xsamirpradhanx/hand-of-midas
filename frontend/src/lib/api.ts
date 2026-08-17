// API Client
import { config } from '../config';
import type {
  WatchlistEntry,
  QuoteResponse,
  OHLCVDataPoint,
  ChartConfigResponse,
  IndicatorConfig,
  OptionsChainResponse,
  UnusualActivityItem,
  PortfolioSummary,
  Position,
  Alert,
  OptionsAnalyticsResponse,
  MarketInternalsResponse,
  SectorHeatmapResponse,
  SymbolSearchResult,
} from '../types';

import { userPool } from '../contexts/AuthContext';

// API_BASE_URL already contains the /api prefix (e.g. '/api' in dev, the full API Gateway URL in prod).
// All fetchWithAuth paths must start with '/' and must NOT include /api themselves.
// Example: fetchWithAuth('/watchlist') → `${API_BASE_URL}/watchlist` → /api/watchlist ✓
const API_BASE_URL = config.apiUrl.replace(/\/+$/, '');

async function getCognitoToken(): Promise<string | null> {
  const cognitoUser = userPool.getCurrentUser();
  if (!cognitoUser) return null;

  return new Promise((resolve) => {
    cognitoUser.getSession((err: any, session: any) => {
      if (err || !session || !session.isValid()) {
        resolve(null);
        return;
      }
      resolve(session.getIdToken().getJwtToken());
    });
  });
}

/** Same request/auth/error handling as fetchWithAuth, but returns the raw Response — for callers that need headers (e.g. screener polling reads X-Screener-Computed-At), not just the parsed body. */
async function fetchWithAuthRaw(path: string, options: RequestInit = {}): Promise<Response> {
  const token = await getCognitoToken();

  const headers = new Headers(options.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }

  try {
    const rawProvider = window.localStorage.getItem('dashboard_dataProvider');
    const provider = rawProvider ? JSON.parse(rawProvider) : 'yahoo';
    headers.set('X-Data-Provider', provider);
  } catch (e) {
    headers.set('X-Data-Provider', 'yahoo');
  }

  const fetchUrl = `${API_BASE_URL}${path}`;
  const response = await fetch(fetchUrl, { ...options, headers });

  const requestedProvider = headers.get('X-Data-Provider');
  const actualProvider = response.headers.get('X-Source-Provider');

  if (actualProvider && actualProvider !== 'cache' && requestedProvider && actualProvider !== requestedProvider) {
    window.dispatchEvent(new CustomEvent('DATA_PROVIDER_FALLBACK', {
      detail: { requested: requestedProvider, actual: actualProvider }
    }));
  }

  if (response.status === 401 || !response.ok) {
    const errorBody = await response.clone().json().catch(() => ({}));
    throw new Error(errorBody.error || `API Error: ${response.status} ${response.statusText}`);
  }

  return response;
}

async function fetchWithAuth(path: string, options: RequestInit = {}) {
  const response = await fetchWithAuthRaw(path, options);

  // Handle 204 No Content
  if (response.status === 204) {
    return null as any;
  }

  return response.json();
}

const screenerCache = new Map<string, { timestamp: number; data: any; computedAt: string | null }>();

export const api = {
  getWatchlist: async (): Promise<WatchlistEntry[]> => {
    const res = await fetchWithAuth('/watchlist');
    return res?.items || [];
  },
  
  addToWatchlist: (symbol: string): Promise<void> => 
    fetchWithAuth('/watchlist', { method: 'POST', body: JSON.stringify({ symbol }) }),
    
  removeFromWatchlist: (symbol: string): Promise<void> => 
    fetchWithAuth(`/watchlist/${symbol}`, { method: 'DELETE' }),

  reorderWatchlist: (symbols: string[]): Promise<void> =>
    fetchWithAuth('/watchlist/reorder', { method: 'PUT', body: JSON.stringify({ symbols }) }),

  getMarketData: (symbol: string, interval = '1day', outputsize = '200', extendedHours?: boolean): Promise<{ symbol: string, interval: string, data: OHLCVDataPoint[] }> => 
    fetchWithAuth(`/market-data/${symbol}?interval=${interval}&outputsize=${outputsize}${extendedHours !== undefined ? `&extendedHours=${extendedHours}` : ''}`),

  getQuote: (symbol: string): Promise<QuoteResponse> => 
    fetchWithAuth(`/quote/${symbol}`),

  searchSymbols: async (query: string): Promise<SymbolSearchResult[]> => {
    const res = await fetchWithAuth(`/search/symbols?q=${encodeURIComponent(query)}`);
    return res?.results || [];
  },

  getChartConfig: (symbol: string): Promise<ChartConfigResponse> => 
    fetchWithAuth(`/chart-config/${symbol}`),

  saveChartConfig: (symbol: string, config: { indicators: IndicatorConfig[] }): Promise<void> => 
    fetchWithAuth(`/chart-config/${symbol}`, { method: 'PUT', body: JSON.stringify(config) }),

  getOptionsChain: (symbol: string, expiry?: string): Promise<OptionsChainResponse> => 
    fetchWithAuth(`/options/chain/${symbol}${expiry ? `?expiry=${expiry}` : ''}`),
    
  getOptionsMetrics: (symbol: string, expiry?: string): Promise<any> => 
    fetchWithAuth(`/options/metrics/${symbol}?_t=${Date.now()}${expiry ? `&expiry=${expiry}` : ''}`),
    
  getAiInsights: (symbol: string, expiry?: string): Promise<{ insight: string }> => 
    fetchWithAuth(`/options/insights/${symbol}${expiry ? `?expiry=${expiry}` : ''}`),
    
  getAlerts: (): Promise<Alert[]> =>
    fetchWithAuth('/alerts'),

  getNews: (): Promise<any[]> =>
    fetchWithAuth('/news'),

  createAlert: (alert: Pick<Alert, 'symbol' | 'message' | 'severity'>): Promise<Alert> =>
    fetchWithAuth('/alerts', { method: 'POST', body: JSON.stringify(alert) }),

  deleteAlert: (id: string): Promise<void> =>
    fetchWithAuth(`/alerts/${id}`, { method: 'DELETE' }),

  getUnusualActivity: async (filters?: { symbol?: string; minSigma?: number; side?: string; dteMax?: number }): Promise<UnusualActivityItem[]> => {
    const params = new URLSearchParams();
    if (filters?.symbol) params.append('symbol', filters.symbol);
    if (filters?.minSigma) params.append('minSigma', filters.minSigma.toString());
    if (filters?.side && filters.side !== 'all') params.append('side', filters.side);
    if (filters?.dteMax) params.append('dteMax', filters.dteMax.toString());
    const res = await fetchWithAuth(`/options/unusual?${params.toString()}`);
    return res?.data || [];
  },

  getRealizedVolHistory: (symbol: string): Promise<{ date: string; realizedVol: number; atm_realizedVol: number; iv_rank: number; iv_percentile: number }[]> => 
    fetchWithAuth(`/options/realized-volatility/${symbol}`),

  getPortfolioPositions: async (): Promise<Position[]> => {
    const res = await fetchWithAuth('/portfolio/positions');
    return res?.positions || [];
  },

  addPosition: (position: Omit<Position, 'id' | 'status'>): Promise<Position> => 
    fetchWithAuth('/portfolio/positions', { method: 'POST', body: JSON.stringify(position) }),

  updatePosition: (id: string, position: Partial<Position>): Promise<Position> => 
    fetchWithAuth(`/portfolio/positions/${id}`, { method: 'PUT', body: JSON.stringify(position) }),

  deletePosition: (id: string): Promise<void> => 
    fetchWithAuth(`/portfolio/positions/${id}`, { method: 'DELETE' }),

  getPortfolioSummary: (): Promise<PortfolioSummary> => 
    fetchWithAuth('/portfolio/summary'),

  runScenario: (deltaSpot: number, deltaIV: number): Promise<{ scenarioPL: number }> =>
    fetchWithAuth('/portfolio/scenario', { method: 'POST', body: JSON.stringify({ deltaSpot, deltaIV }) }),

  getPredictiveZones: (symbol: string, expiry?: string): Promise<any> =>
    fetchWithAuth(`/predictive/zones/${symbol}${expiry ? `?expiry=${expiry}` : ''}`),

  getOptionsAnalytics: (symbol: string, options?: { includeVix?: boolean; expiry?: string }): Promise<OptionsAnalyticsResponse> => {
    const params = new URLSearchParams();
    if (options?.includeVix === false) params.set('includeVix', 'false');
    if (options?.expiry) params.set('expiry', options.expiry);
    const qs = params.toString();
    return fetchWithAuth(`/options-analytics/${symbol}${qs ? `?${qs}` : ''}`);
  },

  /**
   * `force: true` skips this 15s in-memory cache — used when polling after
   * refreshScreener() so a just-triggered scan's result isn't masked by a
   * stale in-memory hit.
   */
  getScreener: async (
    mode: 'premarket' | 'open' | 'momentum' | 'highdemand',
    opts?: { force?: boolean },
  ): Promise<{ results: any[]; computedAt: string | null }> => {
    const now = Date.now();
    const cacheKey = `SCREENER_${mode}`;
    if (!opts?.force) {
      const cached = screenerCache.get(cacheKey);
      if (cached && now - cached.timestamp < 15000) {
        console.log(`[Frontend Cache] Serving screener ${mode} from memory.`);
        return { results: cached.data, computedAt: cached.computedAt };
      }
    }

    const response = await fetchWithAuthRaw(`/screener?mode=${mode}`);
    const data = response.status === 204 ? [] : await response.json();
    const computedAt = response.headers.get('X-Screener-Computed-At');
    screenerCache.set(cacheKey, { timestamp: now, data, computedAt });
    return { results: data, computedAt };
  },

  /** Kicks off an out-of-band rescan ("Refresh Scan" button) — a full scan takes minutes, so this returns as soon as it's handed off. Poll getScreener({force: true}) and watch computedAt to know when it lands. */
  refreshScreener: (mode: 'premarket' | 'open' | 'momentum' | 'highdemand'): Promise<{ ok: boolean; mode: string; message: string }> =>
    fetchWithAuth(`/screener/refresh?mode=${mode}`, { method: 'POST' }),

  getDiagonalScreener: (): Promise<any[]> =>
    fetchWithAuth('/screener/diagonal'),

  getMarketInternals: (): Promise<MarketInternalsResponse> =>
    fetchWithAuth('/market-internals'),

  getSectors: (): Promise<SectorHeatmapResponse> =>
    fetchWithAuth('/sectors'),
};
