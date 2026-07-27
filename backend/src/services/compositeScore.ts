import type { FactorResult } from './factors/types.js';
import type { OHLCVDataPoint } from '../types.js';

// ---------------------------------------------------------------------------
// Regime Detection
// ---------------------------------------------------------------------------

type MarketRegime = 'trending' | 'mean_reverting' | 'high_volatility' | 'neutral';

/**
 * Detect market regime from the outputs of already-computed factor plugins.
 * Uses Hurst Exponent factor for trend/mean-reversion classification and
 * ATR Volatility factor for high-volatility detection.
 * Returns 'neutral' if neither factor is available.
 */
function detectRegime(factors: FactorResult[]): MarketRegime {
  const hurstFactor = factors.find(f => f.factorName.includes('Hurst'));
  const atrFactor = factors.find(f => f.factorName.includes('ATR'));

  // Extract Hurst H value from reasoning string (e.g. "Hurst Exponent H = 0.62")
  let hurstH: number | null = null;
  if (hurstFactor?.reasoning) {
    const match = hurstFactor.reasoning.match(/H\s*=\s*([\d.]+)/);
    if (match) hurstH = parseFloat(match[1]);
  }

  // Extract ATR% from reasoning string (e.g. "14-Day ATR is $4.20 (3.1% of price)")
  let atrPct: number | null = null;
  if (atrFactor?.reasoning) {
    const match = atrFactor.reasoning.match(/\(([\d.]+)%\s*of price\)/);
    if (match) atrPct = parseFloat(match[1]);
  }

  // High-volatility: ATR% in top quartile (>3% is elevated intraday range)
  if (atrPct !== null && atrPct > 3.0) return 'high_volatility';

  // Trending regime: Hurst > 0.55 (persistent/trending price series)
  if (hurstH !== null && hurstH > 0.55) return 'trending';

  // Mean-reverting regime: Hurst < 0.45 (anti-persistent series)
  if (hurstH !== null && hurstH < 0.45) return 'mean_reverting';

  return 'neutral';
}

/**
 * Regime-conditional weight multipliers for each factor category.
 * Multiplier > 1 = up-weight this factor in the current regime.
 * Multiplier < 1 = down-weight (less relevant in this regime).
 *
 * Rationale:
 * - Trending: VWAP and CVD are leading signals; GEX/KAMA reversions are noise
 * - Mean-Reverting: GEX flip and KAMA Z-score are the primary edges
 * - High-Volatility: Term Structure and Risk Reversal capture skew panic; HVLR noise
 * - Neutral: all factors equal weight (no adjustment)
 */
const REGIME_MULTIPLIERS: Record<MarketRegime, Record<string, number>> = {
  trending: {
    'Anchored VWAP': 1.5,
    'Cumulative Volume Delta': 1.4,
    'Hurst Exponent': 1.3,
    'Volume Profile': 1.2,
    'KAMA': 0.6,
    'Dealer Microstructure': 0.7,
    'Options Squeeze': 0.8,
  },
  mean_reverting: {
    'Dealer Microstructure': 1.5,
    'KAMA': 1.5,
    'Options Squeeze': 1.3,
    'High-Volume Low-Range': 1.2,
    'Anchored VWAP': 0.7,
    'Cumulative Volume Delta': 0.8,
    'Hurst Exponent': 0.6,
  },
  high_volatility: {
    'Volatility Term Structure': 1.6,
    'Risk Reversal Skew': 1.5,
    'ATR Dynamic': 1.4,
    'Dealer Microstructure': 1.2,
    'High-Volume Low-Range': 0.5,
    'Catalyst Drift': 0.7,
  },
  neutral: {},
};

/**
 * Apply regime multipliers to a factor's base weight.
 * Matches factor name by substring so partial names work (e.g. "KAMA" matches "KAMA & Z-Score Distance").
 */
function applyRegimeMultiplier(factorName: string, baseWeight: number, regime: MarketRegime): number {
  const multipliers = REGIME_MULTIPLIERS[regime];
  for (const [key, multiplier] of Object.entries(multipliers)) {
    if (factorName.includes(key)) {
      return baseWeight * multiplier;
    }
  }
  return baseWeight; // No match → unchanged
}

export interface AISynthesisResult {
  summary: string;
  bias: 'bullish' | 'bearish' | 'neutral';
  overallConviction: number;
  buyZone: { top: number; bottom: number };
  sellZone: { top: number; bottom: number };
  keyFactors: FactorResult[];
}

/**
 * Compute 14-period ATR from OHLCV bars.
 * Returns ATR as a fraction of current price (e.g. 0.03 = 3%).
 */
function computeAtrPercent(bars: OHLCVDataPoint[], currentPrice: number): number {
  if (!bars || bars.length < 2) return 0.015; // fallback 1.5%
  const period = Math.min(14, bars.length - 1);
  const trValues: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    trValues.push(tr);
  }
  // Simple average of last `period` TR values (quick ATR proxy)
  const slice = trValues.slice(-period);
  const atr = slice.reduce((a, b) => a + b, 0) / slice.length;
  return currentPrice > 0 ? atr / currentPrice : 0.015;
}

export class CompositeScoreAgent {
  synthesize(
    symbol: string,
    currentPrice: number,
    factors: FactorResult[],
    bars?: OHLCVDataPoint[],
  ): AISynthesisResult {
    if (!factors || factors.length === 0) {
      return {
        summary: `Insufficient factor inputs to run AI synthesis for ${symbol}.`,
        bias: 'neutral',
        overallConviction: 0.5,
        buyZone: { top: Number((currentPrice * 0.99).toFixed(2)), bottom: Number((currentPrice * 0.97).toFixed(2)) },
        sellZone: { top: Number((currentPrice * 1.03).toFixed(2)), bottom: Number((currentPrice * 1.01).toFixed(2)) },
        keyFactors: [],
      };
    }

    // ── 1. Detect current market regime ────────────────────────────────────────
    const regime = detectRegime(factors);

    // ── 2. Normalize weights dynamically (with regime adjustment) ─────────────
    // Some factors (e.g. Dealer GEX) return null for stocks without options data,
    // so the active factor set can have a lower-than-designed total weight.
    // Re-normalize so the weighted averages remain meaningful.
    // Regime multipliers are applied before normalization so they influence bias/conviction.
    const regimeAdjustedWeights = factors.map(f => ({
      factor: f,
      adjustedWeight: applyRegimeMultiplier(f.factorName, f.weight, regime),
    }));
    const activeWeightTotal = regimeAdjustedWeights.reduce((sum, { adjustedWeight }) => sum + adjustedWeight, 0);
    const normalizeWeight = (w: number) => (activeWeightTotal > 0 ? w / activeWeightTotal : 1 / factors.length);

    let weightedBuySum = 0;
    let buyWeightTotal = 0;
    let weightedSellSum = 0;
    let sellWeightTotal = 0;
    let bullishWeight = 0;
    let bearishWeight = 0;

    for (const { factor: f, adjustedWeight } of regimeAdjustedWeights) {
      const nw = normalizeWeight(adjustedWeight);
      if (f.bias === 'bullish') bullishWeight += nw;
      if (f.bias === 'bearish') bearishWeight += nw;

      if (f.buyTarget !== undefined && f.buyTarget > 0) {
        weightedBuySum += f.buyTarget * nw;
        buyWeightTotal += nw;
      }
      if (f.sellTarget !== undefined && f.sellTarget > 0) {
        weightedSellSum += f.sellTarget * nw;
        sellWeightTotal += nw;
      }
    }

    const rawBuyCenter = buyWeightTotal > 0 ? (weightedBuySum / buyWeightTotal) : (currentPrice * 0.98);
    const rawSellCenter = sellWeightTotal > 0 ? (weightedSellSum / sellWeightTotal) : (currentPrice * 1.02);

    // ── 2. Loosen hard clamp: allow zones up to ±8% from current price ────────
    // Previously clamped at ±1.5%, which destroyed any zone placed at real
    // support/resistance levels (VPVR VAL, HVLR clusters, etc.).
    // We still enforce a minimum distance (0.5%) so zones never sit ON the price.
    const buyCenter = Math.min(currentPrice * 0.995, Math.max(currentPrice * 0.92, rawBuyCenter));
    const sellCenter = Math.max(currentPrice * 1.005, Math.min(currentPrice * 1.08, rawSellCenter));

    // ── 3. ATR-adaptive zone spread ───────────────────────────────────────────
    // Previously a fixed 1.2% regardless of stock volatility.
    // Now we use 50% of the 14-day ATR%, clamped between 0.8% (stable stocks)
    // and 4.0% (highly volatile stocks like NVDA, TSLA).
    const atrPct = computeAtrPercent(bars ?? [], currentPrice);
    const spreadPct = Math.max(0.008, Math.min(0.04, atrPct * 0.5));
    const spread = currentPrice * spreadPct;

    const buyZone = {
      top: Number((buyCenter + spread / 2).toFixed(2)),
      bottom: Number(Math.max(0, buyCenter - spread / 2).toFixed(2)),
    };

    const sellZone = {
      top: Number((sellCenter + spread / 2).toFixed(2)),
      bottom: Number(Math.max(0, sellCenter - spread / 2).toFixed(2)),
    };

    // ── 4. Bias & conviction ──────────────────────────────────────────────────
    const bias: 'bullish' | 'bearish' | 'neutral' =
      bullishWeight > bearishWeight ? 'bullish' : bearishWeight > bullishWeight ? 'bearish' : 'neutral';

    const netRatio = Math.abs(bullishWeight - bearishWeight); // already normalized, sums to 1
    const overallConviction = Number(Math.min(0.98, Math.max(0.45, 0.5 + netRatio * 0.45)).toFixed(2));

    const topFactorDetails = factors
      .map(f => `• [${f.factorName}] (${f.bias.toUpperCase()}): ${f.reasoning}`)
      .join('\n');

    const regimeLabel = regime === 'trending' ? '📈 TRENDING' : regime === 'mean_reverting' ? '↔️ MEAN-REVERTING' : regime === 'high_volatility' ? '⚡ HIGH-VOLATILITY' : '⚖️ NEUTRAL';
    const summary =
      `[AI INVESTMENT COMMITTEE REPORT for ${symbol}]\n` +
      `Regime: ${regimeLabel} | Consensus: ${bias.toUpperCase()} (${(overallConviction * 100).toFixed(0)}% Conviction).\n` +
      `Evaluated ${factors.length} quantitative factor vectors (regime-adjusted weight total: ${activeWeightTotal.toFixed(2)}):\n` +
      `Zone spread: ±${(spreadPct * 100).toFixed(2)}% (ATR-adaptive, raw ATR%: ${(atrPct * 100).toFixed(2)}%)\n` +
      topFactorDetails;

    return {
      summary,
      bias,
      overallConviction,
      buyZone,
      sellZone,
      keyFactors: factors,
    };
  }
}
