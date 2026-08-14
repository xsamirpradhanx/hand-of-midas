import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

export class EstimatedCvdFactor implements PredictiveFactor {
  // Renamed from 'Cumulative Volume Delta (CVD)' — this is a close-position
  // bar-range heuristic, not true bid/ask CVD. Real CVD requires trade-direction
  // data (tick-level or L2), which the daily OHLCV pipeline does not provide.
  name = 'Estimated CVD (Bar-Position Delta)';
  bucket = 'ORDER_FLOW' as const;
  correlationGroup = 'CVD';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars, currentPrice } = input;
    if (!bars || bars.length < 10) return null;

    let cvd = 0;
    const cvdHistory: number[] = [];

    for (const b of bars) {
      const range = b.high - b.low;
      const vol = b.volume || 1;
      
      let buyRatio = 0.5;
      if (range > 0) {
        buyRatio = (b.close - b.low) / range;
      }
      
      const buyVol = vol * buyRatio;
      const sellVol = vol * (1 - buyRatio);
      const delta = buyVol - sellVol;

      cvd += delta;
      cvdHistory.push(cvd);
    }

    // Measure recent 10-bar CVD trend vs. 10-bar Price trend for Absorption Divergence
    const recentBars = bars.slice(-10);
    const recentCvd = cvdHistory.slice(-10);
    
    const priceChange = currentPrice - recentBars[0].close;
    const cvdChange = recentCvd[recentCvd.length - 1] - recentCvd[0];

    let bias: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    let reasoning = '';

    if (priceChange < 0 && cvdChange > 0) {
      // Bullish divergence: price fell but bars closed nearer their highs, implying
      // net buying pressure inside each bar range. Estimate only — not order-flow.
      bias = 'bullish';
      reasoning = `Bullish bar-position divergence: price fell $${Math.abs(priceChange).toFixed(2)} over 10 bars, but close-in-range implies net buying of ~+${Math.round(cvdChange).toLocaleString()} shares. Estimated from bar geometry, not true order flow.`;
    } else if (priceChange > 0 && cvdChange < 0) {
      // Bearish divergence: price rose but bars closed nearer their lows.
      bias = 'bearish';
      reasoning = `Bearish bar-position divergence: price rose $${priceChange.toFixed(2)} over 10 bars, but close-in-range implies net selling of ~-${Math.abs(Math.round(cvdChange)).toLocaleString()} shares. Estimated from bar geometry, not true order flow.`;
    } else {
      bias = cvdChange >= 0 ? 'bullish' : 'bearish';
      reasoning = `10-bar bar-position delta: ${cvdChange >= 0 ? '+' : ''}${Math.round(cvdChange).toLocaleString()} shares (estimated). Direction aligns with price.`;
    }

    const buyTarget = bias === 'bullish' ? currentPrice * 0.99 : currentPrice * 0.98;
    const sellTarget = bias === 'bearish' ? currentPrice * 1.01 : currentPrice * 1.02;

    return {
      factorName: this.name,
      buyTarget,
      sellTarget,
      bias,
      weight: 0.25,
      bucket: 'ORDER_FLOW',
      correlationGroup: 'CVD',
      reasoning,
    };
  }
}
