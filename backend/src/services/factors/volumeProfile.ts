import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

export class VolumeProfileFactor implements PredictiveFactor {
  name = 'Volume Profile (VPVR)';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars, currentPrice } = input;
    if (!bars || bars.length === 0) return null;

    // Find min and max price over historical bars
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    for (const b of bars) {
      if (b.low < minPrice) minPrice = b.low;
      if (b.high > maxPrice) maxPrice = b.high;
    }

    if (minPrice === Infinity || maxPrice === -Infinity || maxPrice === minPrice) return null;

    // Build 50 price buckets
    const numBuckets = 50;
    const bucketSize = (maxPrice - minPrice) / numBuckets;
    const buckets = new Array(numBuckets).fill(0);

    for (const b of bars) {
      const avgPrice = (b.high + b.low + b.close) / 3;
      const bucketIdx = Math.min(numBuckets - 1, Math.max(0, Math.floor((avgPrice - minPrice) / bucketSize)));
      buckets[bucketIdx] += b.volume || 1;
    }

    // Find POC (Point of Control)
    let pocIdx = 0;
    let maxVol = 0;
    let totalVol = 0;

    for (let i = 0; i < numBuckets; i++) {
      totalVol += buckets[i];
      if (buckets[i] > maxVol) {
        maxVol = buckets[i];
        pocIdx = i;
      }
    }

    // Value Area: 70% of total volume expanding outward from POC
    const targetValVolume = totalVol * 0.7;
    let accumulatedVol = buckets[pocIdx];
    let lowerIdx = pocIdx;
    let upperIdx = pocIdx;

    while (accumulatedVol < targetValVolume && (lowerIdx > 0 || upperIdx < numBuckets - 1)) {
      const nextLowerVol = lowerIdx > 0 ? buckets[lowerIdx - 1] : -1;
      const nextUpperVol = upperIdx < numBuckets - 1 ? buckets[upperIdx + 1] : -1;

      if (nextUpperVol >= nextLowerVol && upperIdx < numBuckets - 1) {
        upperIdx++;
        accumulatedVol += buckets[upperIdx];
      } else if (lowerIdx > 0) {
        lowerIdx--;
        accumulatedVol += buckets[lowerIdx];
      } else if (upperIdx < numBuckets - 1) {
        upperIdx++;
        accumulatedVol += buckets[upperIdx];
      } else {
        break;
      }
    }

    const val = minPrice + (lowerIdx * bucketSize);
    const vah = minPrice + ((upperIdx + 1) * bucketSize);
    const poc = minPrice + ((pocIdx + 0.5) * bucketSize);

    // Dynamic buy/sell targets based on current price relative to Value Area
    const buyTarget = Math.min(val, currentPrice * 0.99);
    const sellTarget = Math.max(vah, currentPrice * 1.01);
    const bias = currentPrice > poc ? 'bullish' : currentPrice < poc ? 'bearish' : 'neutral';

    return {
      factorName: this.name,
      buyTarget,
      sellTarget,
      bias,
      weight: 0.35, // Strong weight for institutional volume distribution
      reasoning: `Value Area Low (VAL) at $${val.toFixed(2)}, Value Area High (VAH) at $${vah.toFixed(2)}, POC at $${poc.toFixed(2)}.`,
    };
  }
}
