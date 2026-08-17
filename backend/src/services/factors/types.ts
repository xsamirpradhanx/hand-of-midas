import type { OHLCVDataPoint } from '../../types.js';
import type { PolygonNewsArticle } from '../polygon.js';
import type { AggregatedSentiment } from '../sentimentAggregator.js';

/**
 * Describes which evidence category a factor belongs to.
 * Used by IndependentEvidenceEngine to de-duplicate correlated signals.
 */
export type FactorBucket =
  | 'PRICE_STRUCTURE'  // VWAP, Volume Profile, KAMA, HVLR
  | 'ORDER_FLOW'       // CVD, Smart Money
  | 'OPTIONS'          // GEX, Vanna, IV/RV, Skew, Term Structure, MaxPain, Squeeze
  | 'CATALYST'         // News, Insider
  | 'POSITIONING'      // Hurst, ATR (regime classification)
  | 'MOMENTUM'         // AI-generated alpha factors
  | 'LIQUIDITY';       // (reserved for future liquidity factors)

export interface FactorResult {
  factorName: string;
  buyTarget?: number;
  sellTarget?: number;
  bias: 'bullish' | 'bearish' | 'neutral';
  weight: number; // 0.0 to 1.0
  reasoning: string;
  /** Which evidence bucket this factor belongs to. */
  bucket: FactorBucket;
  /**
   * Correlation group key. Factors sharing the same group are treated as
   * a single evidence signal by IndependentEvidenceEngine (max conviction wins).
   * Example: 'GEX_COMPLEX' groups DealerHedging, VannaDelta, MaxPain, Squeeze.
   */
  correlationGroup?: string;
}

export interface FactorInput {
  symbol: string;
  currentPrice: number;
  bars: OHLCVDataPoint[];
  optionsChain?: { expirations: string[]; contracts: any[] };
  activeExpiry?: string;
  news?: PolygonNewsArticle[];
  /**
   * 1-minute extended-hours bars for the current trading day, when available.
   * Optional — daily-bar-only factors ignore it; intraday factors (session VWAP)
   * return null if it's missing rather than degrading silently.
   */
  intradayBars?: OHLCVDataPoint[];
  /**
   * Aggregated insider / analyst / social sentiment, when available.
   *
   * Optional and best-effort, like intradayBars: factors that need it return null
   * rather than degrading, so a sentiment provider outage cannot take down the
   * whole engine.
   */
  sentiment?: AggregatedSentiment;
}

export interface PredictiveFactor {
  name: string;
  /** Bucket this factor belongs to — declared at class level. */
  bucket: FactorBucket;
  /** Correlation group — declared at class level. Defaults to factor name if absent. */
  correlationGroup?: string;
  evaluate(input: FactorInput): Promise<FactorResult | null>;
}

