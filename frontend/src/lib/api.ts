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

async function fetchWithAuth(path: string, options: RequestInit = {}) {
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

  if (response.status === 401) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error || `API Error: ${response.status} ${response.statusText}`);
  }

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error || `API Error: ${response.status} ${response.statusText}`);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return null as any;
  }

  return response.json();
}

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
    fetchWithAuth(`/market-data/${symbol}?interval=${interval}&outputsize=${outputsize}${extendedHours ? '&extendedHours=true' : ''}`),

  getQuote: (symbol: string): Promise<QuoteResponse> => 
    fetchWithAuth(`/quote/${symbol}`),

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

  getPredictiveZones: (symbol: string): Promise<any> =>
    fetchWithAuth(`/predictive/zones/${symbol}`),

  getOptionsAnalytics: (symbol: string, options?: { includeVix?: boolean; expiry?: string }): Promise<OptionsAnalyticsResponse> => {
    const params = new URLSearchParams();
    if (options?.includeVix === false) params.set('includeVix', 'false');
    if (options?.expiry) params.set('expiry', options.expiry);
    const qs = params.toString();
    return fetchWithAuth(`/options-analytics/${symbol}${qs ? `?${qs}` : ''}`);
  },

  getScreener: (mode: 'premarket' | 'open'): Promise<any[]> =>
    fetchWithAuth(`/screener?mode=${mode}`),

  getMarketInternals: (): Promise<MarketInternalsResponse> =>
    fetchWithAuth('/market-internals'),

  getSectors: (): Promise<SectorHeatmapResponse> =>
    fetchWithAuth('/sectors'),
};
