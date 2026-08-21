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

/**
 * One price level a factor believes price may react at.
 *
 * `buyTarget` / `sellTarget` allow exactly one level per side, which starved the
 * zone picker: measured over 320 point-in-time observations, it had two or more
 * credible clusters to choose from in only 34% (demand) and 42% (supply) of
 * cases, and exactly ONE in half of them. No scoring rule can improve a choice
 * of one, which is why the reachability prior — a scoring change — moved so
 * little. `levels` lifts that cap.
 */
export interface FactorLevel {
  readonly price: number;
  /**
   * Which side of the book this level belongs on. `pivot` lets a factor emit a
   * level without asserting a side; compositeScore assigns it by position
   * relative to spot, the same way it already treats buy/sell targets.
   */
  readonly kind: 'support' | 'resistance' | 'pivot';
  /**
   * Relative importance within this factor's own emissions, 0-1. Scales the
   * factor's weight when clustering, so a POC and a far value-area edge do not
   * carry identical influence. Defaults to 1.
   */
  readonly strength?: number;
  /** Short human label, e.g. "POC", "VAH", "pivot cluster 2". */
  readonly label?: string;
}

export interface FactorResult {
  factorName: string;
  buyTarget?: number;
  sellTarget?: number;
  /**
   * Additional levels beyond the single buy/sell pair. Optional and additive —
   * a factor that emits neither behaves exactly as before.
   */
  levels?: readonly FactorLevel[];
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
  /**
   * Whether this factor casts a directional vote. Defaults to true.
   *
   * Set false for factors that are structurally incapable of a direction —
   * level providers (Swing Structure emits support/resistance for zone
   * clustering) and volatility-regime reads (ATR, IV/RV measure how much price
   * moves, not which way). Their `bias` is hardcoded neutral by design.
   *
   * This matters because IndependentEvidenceEngine computes a bucket's score as
   * (bullish - bearish) / total, with total including neutral weight. A
   * permanent non-voter therefore sat in the denominator forever and only ever
   * shrank the numerator's share: measured across NVDA/GLD/JPM/XOM/AAPL/CAT,
   * PRICE_STRUCTURE scores were understated by ~31% (0.528 where the voters
   * alone said 0.765), because the largest single weight in that bucket —
   * Swing Structure at 0.38 — could never vote.
   *
   * Note the distinction from a factor that CAN vote and chose neutral (KAMA,
   * Hurst when not trending). That is a real "I looked and saw no edge" signal
   * and must keep diluting. Only never-voters are excluded — the same
   * ABSTAIN-vs-scored distinction learningCore.factorVote makes.
   *
   * Excluding them costs nothing elsewhere: compositeScore reads buyTarget /
   * sellTarget straight off the factor list, so their levels still feed zones.
   */
  directional?: boolean;
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

