// ─── Frontend Types ───

export interface OHLCVDataPoint {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface QuoteResponse {
  readonly symbol: string;
  readonly name: string;
  readonly price: number;
  readonly change: number;
  readonly changePercent: number;
  readonly preMarketPrice?: number;
  readonly preMarketChange?: number;
  readonly preMarketChangePercent?: number;
}

export interface WatchlistEntry {
  readonly symbol: string;
  readonly addedAt: string;
}

export interface IndicatorConfig {
  readonly type: string;
  readonly enabled: boolean;
  readonly params: Record<string, number | string | boolean>;
  readonly color?: string;
}

export interface ChartConfigResponse {
  readonly symbol: string;
  readonly indicators: IndicatorConfig[];
  readonly updatedAt: string;
}

export interface OptionsContract {
  ticker: string;
  symbol: string;
  strike: number;
  expiry: string;
  dte: number;
  calendarDTE: number;
  type: 'call' | 'put';
  bid: number;
  ask: number;
  mid: number;
  last: number;
  volume: number;
  openInterest: number;
  volumeOIRatio: number;
  impliedVolatility: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
  intrinsicValue: number;
  timeValue: number;
  itm: boolean;
  whaleScore: number | null;
}

export interface OptionsChainResponse {
  symbol: string;
  underlyingPrice: number;
  expirations: string[];
  chain: Record<string, OptionsContract[]>;
}

export interface UnusualActivityItem {
  symbol: string;
  strike: number;
  expiry: string;
  dte: number;
  side: 'call' | 'put';
  premium: number;
  volume: number;
  openInterest: number;
  volumeOIRatio: number;
  volumeZScore: number;
  premiumZScore: number;
  ivZScore: number;
  isSweep: boolean;
  compositeSigma: number;
  flagReasons: string[];
  contractTicker: string;
}

export interface Position {
  id: string;
  symbol: string;
  type: 'stock' | 'option';
  strategy: string;
  legs: PositionLeg[];
  openDate: string;
  closeDate?: string;
  status: 'open' | 'closed';
  notes?: string;
  tags?: string[];
}

export interface PositionLeg {
  ticker: string;
  quantity: number;
  costBasis: number;
  currentPrice?: number;
  optionDetails?: {
    strike: number;
    expiry: string;
    type: 'call' | 'put';
    multiplier: number;
  };
}

export interface PortfolioSummary {
  totalValue: number;
  totalCost: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  netDelta: number;
  netGamma: number;
  netThetaPerDay: number;
  netVega: number;
  positions: PositionWithGreeks[];
}

export interface PositionWithGreeks extends Position {
  currentValue: number;
  unrealizedPnL: number;
  delta: number;
  theta: number;
  vega: number;
}

export interface Alert {
  pk: string;
  sk: string;
  id?: string;
  symbol: string;
  message: string;
  timestamp: string;
  severity: 'high' | 'medium';
}

export interface OptionsAnalyticsResponse {
  symbol: string;
  spotPrice: number;
  asOf: string;
  riskReversal: {
    expiry: string;
    putStrike: number;
    callStrike: number;
    putDelta: number;
    callDelta: number;
    putIV: number;
    callIV: number;
    skew: number;
    bias: 'bearish' | 'bullish' | 'neutral';
    narrative: string;
  } | null;
  termStructure: {
    points: { expiry: string; dte: number; averageIV: number }[];
    nearIV: number;
    farIV: number;
    slopeRatio: number;
    state: 'backwardation' | 'contango' | 'flat' | 'kinked';
    atrBoundMultiplier: number;
    narrative: string;
  } | null;
  gex: {
    netGamma: number;
    gammaFlipStrike: number;
    maxAbsGexStrike: number;
  } | null;
  vixTermStructure: OptionsAnalyticsResponse['termStructure'];
}
