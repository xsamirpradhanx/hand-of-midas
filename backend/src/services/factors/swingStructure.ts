import type { OHLCVDataPoint } from '../../types.js';
import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

/**
 * Swing Structure — support and resistance from where price actually turned.
 *
 * WHY THIS EXISTS: every other level-producing factor in the engine emits a *derived*
 * quantity — a VWAP band, a value-area edge, a max-pain strike, a gamma flip. None of
 * them read price structure directly, so the zone clustering in compositeScore.ts had
 * nothing real to cluster. Measured across WULF/NBIS/DIS/AAPL/UWMC, all ten emitted
 * zones came from exactly one contributing factor — the clustering never merged
 * anything — and zone quality was entirely hostage to whichever single factor
 * survived: within ~1% of a true pivot when it happened to be Volume Profile or HVLR,
 * but 22–25% away when it was a stale rolling VWAP (NBIS) or a thin-name Session VWAP
 * (UWMC).
 *
 * A pivot is the simplest and most durable form of support/resistance: a price other
 * participants already defended. Clustering repeated pivots gives levels that are
 * independent of every indicator above, which is what makes genuine confluence
 * possible rather than a count of one.
 *
 * Method:
 *   1. Pivot highs/lows — bars that are the extreme of a ±PIVOT_WINDOW neighbourhood.
 *   2. Cluster pivots that sit within CLUSTER_ATR × ATR of each other.
 *   3. Score each cluster by how often it was touched, weighted toward recent touches
 *      (a level defended last week matters more than one defended six months ago).
 *   4. Emit the highest-scoring support below spot and resistance above.
 */

const PIVOT_WINDOW = 3;      // bars either side that a pivot must dominate
const CLUSTER_ATR = 0.5;     // pivots within this × ATR merge into one level
const RECENCY_HALFLIFE = 40; // bars; a touch this old counts half as much

interface Level {
  price: number;
  touches: number;
  score: number;
}

function computeAtr(bars: OHLCVDataPoint[], period = 14): number {
  if (bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    trs.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    ));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/** Merge nearby pivots into levels, scoring by touch count and recency. */
function buildLevels(
  pivots: { price: number; index: number }[],
  tolerance: number,
  lastIndex: number,
): Level[] {
  if (pivots.length === 0) return [];
  const sorted = [...pivots].sort((a, b) => a.price - b.price);

  const clusters: { price: number; index: number }[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const current = clusters[clusters.length - 1];
    const centre = current.reduce((s, p) => s + p.price, 0) / current.length;
    if (Math.abs(sorted[i].price - centre) <= tolerance) current.push(sorted[i]);
    else clusters.push([sorted[i]]);
  }

  return clusters.map(group => {
    let weightSum = 0;
    let weightedPrice = 0;
    for (const p of group) {
      // Exponential recency decay — a level defended recently is the live one.
      const age = lastIndex - p.index;
      const w = Math.pow(0.5, age / RECENCY_HALFLIFE);
      weightSum += w;
      weightedPrice += p.price * w;
    }
    return {
      price: weightedPrice / weightSum,
      touches: group.length,
      // Repeated defences compound, so touch count is more than linear in value,
      // but a single very recent touch should not outrank a shelf hit five times.
      score: weightSum * Math.sqrt(group.length),
    };
  });
}

export class SwingStructureFactor implements PredictiveFactor {
  name = 'Swing Structure (Pivot S/R)';
  bucket = 'PRICE_STRUCTURE' as const;
  // Deliberately its own group: these levels are derived from price action alone and
  // must count as evidence independent of the VWAP and volume-profile families.
  correlationGroup = 'SWING_STRUCTURE';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars, currentPrice } = input;
    if (!bars || bars.length < PIVOT_WINDOW * 2 + 10) return null;

    const atr = computeAtr(bars);
    if (atr <= 0) return null;

    const highs: { price: number; index: number }[] = [];
    const lows: { price: number; index: number }[] = [];
    for (let i = PIVOT_WINDOW; i < bars.length - PIVOT_WINDOW; i++) {
      const window = bars.slice(i - PIVOT_WINDOW, i + PIVOT_WINDOW + 1);
      if (bars[i].high === Math.max(...window.map(b => b.high))) {
        highs.push({ price: bars[i].high, index: i });
      }
      if (bars[i].low === Math.min(...window.map(b => b.low))) {
        lows.push({ price: bars[i].low, index: i });
      }
    }

    const lastIndex = bars.length - 1;
    const tolerance = CLUSTER_ATR * atr;
    const supports = buildLevels(lows, tolerance, lastIndex).filter(l => l.price < currentPrice);
    const resistances = buildLevels(highs, tolerance, lastIndex).filter(l => l.price > currentPrice);

    const bestSupport = supports.length
      ? supports.reduce((a, b) => (b.score > a.score ? b : a))
      : null;
    const bestResistance = resistances.length
      ? resistances.reduce((a, b) => (b.score > a.score ? b : a))
      : null;

    if (!bestSupport && !bestResistance) return null;

    // Location read only — being nearer one side of the range is not a directional
    // call, so bias stays neutral and this factor contributes levels, not a vote.
    const parts: string[] = [];
    if (bestSupport) {
      parts.push(`support $${bestSupport.price.toFixed(2)} (${bestSupport.touches} pivot${bestSupport.touches === 1 ? '' : 's'}, ${((currentPrice - bestSupport.price) / currentPrice * 100).toFixed(1)}% below)`);
    }
    if (bestResistance) {
      parts.push(`resistance $${bestResistance.price.toFixed(2)} (${bestResistance.touches} pivot${bestResistance.touches === 1 ? '' : 's'}, ${((bestResistance.price - currentPrice) / currentPrice * 100).toFixed(1)}% above)`);
    }

    return {
      factorName: this.name,
      buyTarget: bestSupport?.price,
      sellTarget: bestResistance?.price,
      bias: 'neutral',
      weight: 0.38,
      bucket: 'PRICE_STRUCTURE',
      correlationGroup: 'SWING_STRUCTURE',
      reasoning: `Nearest defended levels from ${bars.length} bars of price action: ${parts.join(', ')}. Recency-weighted pivot clusters (±${PIVOT_WINDOW} bars, merged within ${CLUSTER_ATR}×ATR).`,
    };
  }
}
