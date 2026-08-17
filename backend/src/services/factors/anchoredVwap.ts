import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

/**
 * NOTE ON NAMING: despite the class/factor name, this is a rolling 30-daily-bar
 * (~month) VWAP window recomputed fresh on every call — not a VWAP anchored to a
 * fixed event (earnings, gap, swing point). It rides along with the last 30 bars
 * every day rather than holding a fixed start date, so it behaves like a smoothed
 * moving-average-with-bands, not a classic anchored VWAP. Kept as-is (rename would
 * touch REGIME_MULTIPLIERS/downstream string-matching in compositeScore.ts), but
 * don't confuse it with true anchored VWAP or with SessionVwapFactor, which anchors
 * intraday VWAP lines at fixed session-open timestamps (Day/London/US).
 */
export class AnchoredVwapFactor implements PredictiveFactor {
  name = 'Anchored VWAP (±2σ Bands)';
  bucket = 'PRICE_STRUCTURE' as const;
  correlationGroup = 'VWAP';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars, currentPrice } = input;
    if (!bars || bars.length < 5) return null;

    // Anchor at the most recent significant swing extreme, rather than a fixed
    // 30-bar rolling window.
    //
    // A rolling window makes this a lagging moving average dressed as an anchored
    // VWAP: on a name in a strong trend it trails badly and its ±2σ bands stop
    // containing price at all. On NBIS (spot $277.80) the 30-bar version sat at
    // $205.53 with an upper band of $262.91 — price was *above* its own +2σ band,
    // and that stale band was still being handed to the zone builder as a level,
    // landing 22.5% from the nearest real pivot.
    //
    // Anchoring at the last swing high or low measures the volume-weighted average
    // price paid by everyone who has traded since the move that actually matters —
    // which is what an anchored VWAP is for, and keeps it relevant to a
    // days-to-weeks hold regardless of how far the name has travelled.
    const MIN_ANCHOR_BARS = 10;
    const SEARCH_WINDOW = 60;
    const PIVOT_K = 3;

    const searchStart = Math.max(PIVOT_K, bars.length - SEARCH_WINDOW);
    let anchorIdx = Math.max(0, bars.length - 30);
    for (let i = bars.length - PIVOT_K - 1; i >= searchStart; i--) {
      const w = bars.slice(i - PIVOT_K, i + PIVOT_K + 1);
      const isHigh = bars[i].high === Math.max(...w.map(b => b.high));
      const isLow = bars[i].low === Math.min(...w.map(b => b.low));
      if ((isHigh || isLow) && bars.length - i >= MIN_ANCHOR_BARS) {
        anchorIdx = i;
        break;
      }
    }

    const anchorBars = bars.slice(anchorIdx);
    const anchorDate = bars[anchorIdx]?.datetime?.slice(0, 10) ?? 'recent swing';

    let cumVolume = 0;
    let cumPV = 0;

    for (const b of anchorBars) {
      const typicalPrice = (b.high + b.low + b.close) / 3;
      const vol = b.volume || 1;
      cumPV += typicalPrice * vol;
      cumVolume += vol;
    }

    if (cumVolume === 0) return null;

    const vwap = cumPV / cumVolume;

    // Calculate Volume-Weighted Variance & Standard Deviation
    let cumVariance = 0;
    for (const b of anchorBars) {
      const typicalPrice = (b.high + b.low + b.close) / 3;
      const vol = b.volume || 1;
      const diff = typicalPrice - vwap;
      cumVariance += vol * (diff * diff);
    }

    const stdDev = Math.sqrt(cumVariance / cumVolume);

    const buyTarget = Math.max(0, vwap - (2 * stdDev));
    const sellTarget = vwap + (2 * stdDev);
    const bias = currentPrice > vwap ? 'bullish' : 'bearish';

    return {
      factorName: this.name,
      buyTarget,
      sellTarget,
      bias,
      weight: 0.30,
      bucket: 'PRICE_STRUCTURE',
      correlationGroup: 'VWAP',
      reasoning: `VWAP anchored at the ${anchorDate} swing (${anchorBars.length} bars) is $${vwap.toFixed(2)} (±2σ Bands: Lower $${buyTarget.toFixed(2)}, Upper $${sellTarget.toFixed(2)}). Price is currently ${bias.toUpperCase()} relative to VWAP.`,
    };
  }
}
