import type { OHLCVDataPoint } from '../../types.js';
import type { PolygonNewsArticle } from '../polygon.js';

export interface FactorResult {
  factorName: string;
  buyTarget?: number;
  sellTarget?: number;
  bias: 'bullish' | 'bearish' | 'neutral';
  weight: number; // 0.0 to 1.0
  reasoning: string;
}

export interface FactorInput {
  symbol: string;
  currentPrice: number;
  bars: OHLCVDataPoint[];
  optionsChain?: { expirations: string[]; contracts: any[] };
  news?: PolygonNewsArticle[];
}

export interface PredictiveFactor {
  name: string;
  evaluate(input: FactorInput): Promise<FactorResult | null>;
}
