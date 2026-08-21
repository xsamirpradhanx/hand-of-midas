import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

export class VolumeProfileFactor implements PredictiveFactor {
  name = 'Volume Profile (VPVR)';
  bucket = 'PRICE_STRUCTURE' as const;
  correlationGroup = 'VOLUME_PROFILE';

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

    // Weight each bar's volume by how recent it is, rather than treating six months
    // of trade as equally informative.
    //
    // A flat profile describes where volume traded over the whole window, which stops
    // being a statement about *current* value once a name has re-rated. On NBIS —
    // which ran from $83 to $300 inside this window — the flat value area spanned
    // $148–$300, i.e. essentially the entire move, and the "value area high" was
    // effectively the all-time high. For a HORIZON_BARS-scale trade the relevant
    // question is where trade has concentrated lately, so volume decays with age:
    // a bar one half-life back counts half as much as today's.
    const RECENCY_HALFLIFE_BARS = 30;
    const lastIndex = bars.length - 1;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const avgPrice = (b.high + b.low + b.close) / 3;
      const bucketIdx = Math.min(numBuckets - 1, Math.max(0, Math.floor((avgPrice - minPrice) / bucketSize)));
      const recency = Math.pow(0.5, (lastIndex - i) / RECENCY_HALFLIFE_BARS);
      buckets[bucketIdx] += (b.volume || 1) * recency;
    }

    // Find POC (Point of Control)
    //
    // NOTE: the top buckets are often near-tied (on WULF: 194M / 191M / 175M shares,
    // a 1.5% spread across 50 buckets), and POC alone sets this factor's bias — price
    // above POC reads bullish. So a 1.5% volume difference between two adjacent
    // buckets can flip the directional call. Smoothing the histogram before the
    // argmax was tried as a fix and measured no more stable across window sizes, so
    // it was not kept; the raw argmax at least matches the textbook definition.
    // Worth revisiting with a volume-weighted centroid if this bias proves noisy.
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
      // POC is the single highest-volume price in the window — the most-traded
      // level in the whole profile — and it was computed, narrated in `reasoning`,
      // and then discarded. buyTarget/sellTarget only carry the value-area EDGES,
      // so whenever VAH sat beyond the reachable distance this factor contributed
      // nothing at all to the resistance side. That is exactly what happened on
      // WULX: VAH at $31.25 was dropped as unreachable while POC sat at $19.75,
      // a perfectly usable structural level, and Volume Profile ended up
      // supplying zero resistance candidates.
      //
      // POC carries full strength; the value-area edges are emitted at 0.6 since
      // an edge is where participation thinned out rather than where it
      // concentrated.
      //
      // ONLY the POC. buyTarget already IS `val` (clamped) and sellTarget IS
      // `vah`, so emitting the value-area edges here again would double-weight
      // them in clustering — pulling zones harder toward the edges rather than
      // adding a new candidate. Measured: doing that cost 0.03R of expectancy.
      levels: [{ price: poc, kind: 'pivot', strength: 1.0, label: 'POC' }],
      bias,
      weight: 0.35,
      bucket: 'PRICE_STRUCTURE',
      correlationGroup: 'VOLUME_PROFILE',
      reasoning: `Value Area Low (VAL) at $${val.toFixed(2)}, Value Area High (VAH) at $${vah.toFixed(2)}, POC at $${poc.toFixed(2)}.`,
    };
  }
}
