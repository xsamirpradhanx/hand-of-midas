import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

export class CvdImbalanceFactor implements PredictiveFactor {
  name = 'Cumulative Volume Delta (CVD)';

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
      // Bullish Absorption: Price falling, but aggressive buyers absorbing liquidity
      bias = 'bullish';
      reasoning = `Bullish Order Flow Absorption detected: Price declined by $${Math.abs(priceChange).toFixed(2)}, but CVD increased by +${Math.round(cvdChange).toLocaleString()} shares (Institutional Aggressive Buying).`;
    } else if (priceChange > 0 && cvdChange < 0) {
      // Bearish Absorption: Price rising, but aggressive sellers absorbing liquidity
      bias = 'bearish';
      reasoning = `Bearish Order Flow Absorption detected: Price rose by +$${priceChange.toFixed(2)}, but CVD declined by -${Math.abs(Math.round(cvdChange)).toLocaleString()} shares (Institutional Distribution).`;
    } else {
      bias = cvdChange >= 0 ? 'bullish' : 'bearish';
      reasoning = `10-Bar CVD net flow: ${cvdChange >= 0 ? '+' : ''}${Math.round(cvdChange).toLocaleString()} shares. Order flow aligned with price direction.`;
    }

    const buyTarget = bias === 'bullish' ? currentPrice * 0.99 : currentPrice * 0.98;
    const sellTarget = bias === 'bearish' ? currentPrice * 1.01 : currentPrice * 1.02;

    return {
      factorName: this.name,
      buyTarget,
      sellTarget,
      bias,
      weight: 0.25,
      reasoning,
    };
  }
}
