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
  demandZone: { top: number; bottom: number; confluence: string[] };
  supplyZone: { top: number; bottom: number; confluence: string[] };
  keyFactors: FactorResult[];
  tradePlan?: {
    bias: 'LONG' | 'SHORT' | 'NO TRADE';
    archetype: string;
    trigger: number;
    entryZone: string;
    chasePrice: number;
    expectedMove: number;
    majorResistance: number;
    stretchTarget: number;
    stop: number;
    rewardRisk: number;
    roomToResistance: number;
    roomToSupport: number;
    confirmation: string;
    invalidation: string;
    whyNow: string;
    confidence: number;
  };
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
        demandZone: { top: Number((currentPrice * 0.99).toFixed(2)), bottom: Number((currentPrice * 0.97).toFixed(2)), confluence: [] },
        supplyZone: { top: Number((currentPrice * 1.03).toFixed(2)), bottom: Number((currentPrice * 1.01).toFixed(2)), confluence: [] },
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

    let bullishWeight = 0;
    let bearishWeight = 0;

    for (const { factor: f, adjustedWeight } of regimeAdjustedWeights) {
      const nw = normalizeWeight(adjustedWeight);
      if (f.bias === 'bullish') bullishWeight += nw;
      if (f.bias === 'bearish') bearishWeight += nw;
    }

    const bias: 'bullish' | 'bearish' | 'neutral' =
      bullishWeight > bearishWeight ? 'bullish' : bearishWeight > bullishWeight ? 'bearish' : 'neutral';

    const netRatio = Math.abs(bullishWeight - bearishWeight);
    const overallConviction = Number(Math.min(0.98, Math.max(0.45, 0.5 + netRatio * 0.45)).toFixed(2));

    // ── 5. Market Structure Clustering ──────────────────────────────────────────
    const levels: { price: number; weight: number; source: string }[] = [];
    
    for (const { factor: f, adjustedWeight } of regimeAdjustedWeights) {
      if (f.buyTarget !== undefined && f.buyTarget > 0) {
        levels.push({ price: f.buyTarget, weight: adjustedWeight, source: f.factorName });
      }
      if (f.sellTarget !== undefined && f.sellTarget > 0) {
        levels.push({ price: f.sellTarget, weight: adjustedWeight, source: f.factorName });
      }
    }

    // Sort levels ascending
    levels.sort((a, b) => a.price - b.price);

    const atrPct = computeAtrPercent(bars ?? [], currentPrice);
    const clusterThreshold = Math.max(currentPrice * 0.0025, currentPrice * atrPct * 0.20);
    
    const clusters: { center: number; min: number; max: number; weight: number; sources: string[] }[] = [];
    
    for (const lvl of levels) {
      if (clusters.length === 0) {
        clusters.push({ center: lvl.price, min: lvl.price, max: lvl.price, weight: lvl.weight, sources: [lvl.source] });
      } else {
        const currentCluster = clusters[clusters.length - 1];
        if (lvl.price - currentCluster.max <= clusterThreshold) {
          const newWeight = currentCluster.weight + lvl.weight;
          currentCluster.center = (currentCluster.center * currentCluster.weight + lvl.price * lvl.weight) / newWeight;
          currentCluster.weight = newWeight;
          currentCluster.max = lvl.price;
          if (!currentCluster.sources.includes(lvl.source)) currentCluster.sources.push(lvl.source);
        } else {
          clusters.push({ center: lvl.price, min: lvl.price, max: lvl.price, weight: lvl.weight, sources: [lvl.source] });
        }
      }
    }

    const significantClusters = clusters.filter(c => c.weight >= 0.1);
    const supports = significantClusters.filter(c => c.center < currentPrice).sort((a, b) => b.center - a.center);
    const resistances = significantClusters.filter(c => c.center > currentPrice).sort((a, b) => a.center - b.center);

    const defaultSpread = currentPrice * Math.max(0.005, Math.min(0.02, atrPct * 0.3));
    
    // Construct Demand Zone
    let demandZone = { 
      top: Number((currentPrice - defaultSpread).toFixed(2)), 
      bottom: Number((currentPrice - defaultSpread * 2).toFixed(2)),
      confluence: ['Estimated Support']
    };
    if (supports.length > 0) {
      const s1 = supports[0];
      demandZone = { top: Number(s1.max.toFixed(2)), bottom: Number(s1.min.toFixed(2)), confluence: s1.sources };
    }

    // Construct Supply Zone
    let supplyZone = { 
      top: Number((currentPrice + defaultSpread * 2).toFixed(2)), 
      bottom: Number((currentPrice + defaultSpread).toFixed(2)),
      confluence: ['Estimated Resistance']
    };
    if (resistances.length > 0) {
      const r1 = resistances[0];
      supplyZone = { top: Number(r1.max.toFixed(2)), bottom: Number(r1.min.toFixed(2)), confluence: r1.sources };
    }

    let tradeBias: 'LONG' | 'SHORT' | 'NO TRADE' = 'NO TRADE';
    let archetype = regime === 'trending' ? 'Trend Continuation' : regime === 'high_volatility' ? 'Volatility Reversion' : 'Mean Reversion';
    
    // Initialize defaults
    let trigger = currentPrice;
    let entryZoneStr = 'N/A';
    let chasePrice = currentPrice;
    let stop = currentPrice;
    let expectedMove = 0;
    let majorResistance = supplyZone.bottom;
    let stretchTarget = resistances.length > 1 ? resistances[1].min : supplyZone.top * 1.02;
    let roomToResistance = 0;
    let roomToSupport = 0;
    let rr = 0;
    let confirmation = 'N/A';
    let invalidation = 'N/A';
    let whyNow = 'N/A';

    if (bias === 'bullish') {
      trigger = Number(demandZone.top.toFixed(2));
      entryZoneStr = `$${Number((demandZone.top * 0.995).toFixed(2))}–$${Number((demandZone.top * 1.005).toFixed(2))}`;
      chasePrice = Number((demandZone.top + currentPrice * atrPct * 0.3).toFixed(2));
      stop = Number((demandZone.bottom - currentPrice * 0.005).toFixed(2));
      
      majorResistance = Number(supplyZone.bottom.toFixed(2));
      stretchTarget = Number(supplyZone.top.toFixed(2));
      if (resistances.length > 1) stretchTarget = Number(resistances[1].min.toFixed(2));
      
      expectedMove = majorResistance - trigger;
      roomToResistance = ((majorResistance - currentPrice) / currentPrice) * 100;
      roomToSupport = ((currentPrice - demandZone.top) / currentPrice) * 100;

      const risk = trigger - stop;
      const reward = majorResistance - trigger;
      rr = risk > 0 ? Number((reward / risk).toFixed(1)) : 0;

      if (currentPrice > chasePrice) {
        tradeBias = 'NO TRADE';
        whyNow = `Price is overextended (${roomToSupport.toFixed(1)}% above support).`;
      } else if (rr < 1.0) {
        tradeBias = 'NO TRADE';
        whyNow = `Reward:Risk is ${rr}R (< 1.0R minimum).`;
      } else {
        tradeBias = 'LONG';
        whyNow = `${archetype} near Demand Zone (${demandZone.confluence.length} confluences).`;
      }
      
      confirmation = `Hold $${trigger} and show increasing volume into $${majorResistance}.`;
      invalidation = `15m close below $${stop} on high volume.`;
      
    } else if (bias === 'bearish') {
      trigger = Number(supplyZone.bottom.toFixed(2));
      entryZoneStr = `$${Number((supplyZone.bottom * 0.995).toFixed(2))}–$${Number((supplyZone.bottom * 1.005).toFixed(2))}`;
      chasePrice = Number((supplyZone.bottom - currentPrice * atrPct * 0.3).toFixed(2));
      stop = Number((supplyZone.top + currentPrice * 0.005).toFixed(2));
      
      majorResistance = Number(demandZone.top.toFixed(2));
      stretchTarget = Number(demandZone.bottom.toFixed(2));
      if (supports.length > 1) stretchTarget = Number(supports[1].max.toFixed(2));
      
      expectedMove = trigger - majorResistance;
      roomToResistance = ((currentPrice - majorResistance) / currentPrice) * 100; // Downside room
      roomToSupport = ((supplyZone.bottom - currentPrice) / currentPrice) * 100;

      const risk = stop - trigger;
      const reward = trigger - majorResistance;
      rr = risk > 0 ? Number((reward / risk).toFixed(1)) : 0;

      if (currentPrice < chasePrice) {
        tradeBias = 'NO TRADE';
        whyNow = `Price is overextended (${roomToSupport.toFixed(1)}% below resistance).`;
      } else if (rr < 1.0) {
        tradeBias = 'NO TRADE';
        whyNow = `Reward:Risk is ${rr}R (< 1.0R minimum).`;
      } else {
        tradeBias = 'SHORT';
        whyNow = `${archetype} near Supply Zone (${supplyZone.confluence.length} confluences).`;
      }

      confirmation = `Reject $${trigger} on increasing volume.`;
      invalidation = `15m close above $${stop} on high volume.`;
    }

    const tradePlan = {
      bias: tradeBias,
      archetype,
      trigger,
      entryZone: entryZoneStr,
      chasePrice,
      expectedMove: Number(expectedMove.toFixed(2)),
      majorResistance,
      stretchTarget,
      stop,
      rewardRisk: rr,
      roomToResistance: Number(roomToResistance.toFixed(1)),
      roomToSupport: Number(roomToSupport.toFixed(1)),
      confirmation,
      invalidation,
      whyNow,
      confidence: Math.round(overallConviction * 100)
    };

    const topFactorDetails = factors
      .map(f => `• [${f.factorName}] (${f.bias.toUpperCase()}): ${f.reasoning}`)
      .join('\n');

    const regimeLabel = regime === 'trending' ? '📈 TRENDING' : regime === 'mean_reverting' ? '↔️ MEAN-REVERTING' : regime === 'high_volatility' ? '⚡ HIGH-VOLATILITY' : '⚖️ NEUTRAL';
    const summary =
      `[AI INVESTMENT COMMITTEE REPORT for ${symbol}]\n` +
      `Regime: ${regimeLabel} | Consensus: ${bias.toUpperCase()} (${(overallConviction * 100).toFixed(0)}% Conviction).\n` +
      `Detected ${clusters.length} Liquidity Clusters from factors.\n` +
      topFactorDetails;

    return {
      summary,
      bias,
      overallConviction,
      demandZone,
      supplyZone,
      keyFactors: factors,
      tradePlan
    };
  }
}
