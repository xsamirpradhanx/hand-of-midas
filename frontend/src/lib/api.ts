// API Client
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
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
} from '../types'; // Import types

import { userPool } from '../contexts/AuthContext';

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
  
  const headers = new Headers(options.headers || {});
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const fetchUrl = `${API_BASE_URL}${path}`;
  const response = await fetch(fetchUrl, { ...options, headers });

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

  getMarketData: (symbol: string, interval = '1day', outputsize = '200'): Promise<{ symbol: string, interval: string, data: OHLCVDataPoint[] }> => 
    fetchWithAuth(`/market-data/${symbol}?interval=${interval}&outputsize=${outputsize}`),

  getQuote: (symbol: string): Promise<QuoteResponse> => 
    fetchWithAuth(`/quote/${symbol}`),

  getChartConfig: (symbol: string): Promise<ChartConfigResponse> => 
    fetchWithAuth(`/chart-config/${symbol}`),

  saveChartConfig: (symbol: string, config: { indicators: IndicatorConfig[] }): Promise<void> => 
    fetchWithAuth(`/chart-config/${symbol}`, { method: 'PUT', body: JSON.stringify(config) }),

  getOptionsChain: (symbol: string, expiry?: string): Promise<OptionsChainResponse> => 
    fetchWithAuth(`/options/chain/${symbol}${expiry ? `?expiry=${expiry}` : ''}`),
    
  getUnusualActivity: async (filters?: { symbol?: string; minSigma?: number; side?: string; dteMax?: number }): Promise<UnusualActivityItem[]> => {
    const params = new URLSearchParams();
    if (filters?.symbol) params.append('symbol', filters.symbol);
    if (filters?.minSigma) params.append('minSigma', filters.minSigma.toString());
    if (filters?.side && filters.side !== 'all') params.append('side', filters.side);
    if (filters?.dteMax) params.append('dteMax', filters.dteMax.toString());
    const res = await fetchWithAuth(`/options/unusual?${params.toString()}`);
    return res?.data || [];
  },

  getIVHistory: (symbol: string): Promise<{ date: string; iv: number; atm_iv: number; iv_rank: number; iv_percentile: number }[]> => 
    fetchWithAuth(`/options/${symbol}/iv-history`),

  getPortfolioPositions: (): Promise<Position[]> => 
    fetchWithAuth('/portfolio/positions'),

  addPosition: (position: Omit<Position, 'id' | 'status'>): Promise<Position> => 
    fetchWithAuth('/portfolio/positions', { method: 'POST', body: JSON.stringify(position) }),

  updatePosition: (id: string, position: Partial<Position>): Promise<Position> => 
    fetchWithAuth(`/portfolio/positions/${id}`, { method: 'PATCH', body: JSON.stringify(position) }),

  deletePosition: (id: string): Promise<void> => 
    fetchWithAuth(`/portfolio/positions/${id}`, { method: 'DELETE' }),

  getPortfolioSummary: (): Promise<PortfolioSummary> => 
    fetchWithAuth('/portfolio/summary'),

  runScenario: (deltaSpot: number, deltaIV: number): Promise<PortfolioSummary> => 
    fetchWithAuth('/portfolio/scenario', { method: 'POST', body: JSON.stringify({ deltaSpot, deltaIV }) }),
};
