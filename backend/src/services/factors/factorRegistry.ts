/**
 * The registered factor set.
 *
 * UNREGISTERED 2026-08-21, on measurement rather than taste. Every factor here
 * was scored over 390,733 decision bars of integrity-quarantined history by
 * `npm run factor-audit`, using informedness — P(up | it votes bullish) minus
 * P(up | it votes bearish) — rather than raw accuracy, which in a market that
 * rises 56% of the time is mostly a readout of a factor's own long/short mix.
 *
 * Removed, each at or below zero informedness AND contributing nothing else:
 *
 *   Volume Information Entropy Imbalance    +0.2pp   n=305,060
 *   Spectral Microstructure Inertia         -0.4pp   n=255,318
 *   Estimated CVD (Bar-Position Delta)      -0.6pp   n=390,733
 *   Volume Synchronized Entropy Divergence  -0.7pp   n= 10,165
 *   Asymmetric Kinematic Efficiency         -0.8pp   n=302,242
 *   Fractal Efficiency Liquidity Sweep      -3.2pp   n=  4,692
 *
 * "Contributing nothing else" is the load-bearing half of that test. A factor's
 * levels only reach zone clustering when its bucket is PRICE_STRUCTURE or its
 * name matches compositeScore's PRICE_LOCATION list. All five AI-generated
 * factors are MOMENTUM and Estimated CVD is ORDER_FLOW, so not one of their
 * levels was ever read: they were pure voters, and the votes measured
 * worthless.
 *
 * Factors that vote just as badly but DO supply levels were left ALONE —
 * volumeProfile, anchoredVwap, hvlrSupport. Silencing them was tried and
 * REVERTED: it lifted per-trade expectancy (+39% on the LONG book) and still
 * cut return-per-drawdown from 30.98 to 25.41, because drawdown more than
 * doubled at matched trade volume AND matched long/short mix. Their
 * uninformative votes decorrelate the book; see the `directional` note in
 * types.ts for why that is not a contradiction.
 *
 * MEASURED END TO END. Removing the six above, nothing else changed:
 *
 *              plans   win%   exp/trade      t   maxDD    R/DD   zones
 *   before    12,286  37.9%   +0.1262R    9.65   49.9R   30.98   1.35/1.50
 *   after     13,720  38.1%   +0.1368R   11.03   41.9R   44.62   1.32/1.53
 *
 * Better on every book — LONG +0.1808R to +0.2138R, SHORT +0.0592R to
 * +0.0632R — over MORE trades, with drawdown DOWN and zone placement
 * unchanged. A block bootstrap on R/DD puts it ahead in 80.2% of resamples,
 * short of this project's ~95% bar for an R/DD claim standing alone; the
 * expectancy and t-statistic gains are the firmer half of the result.
 *
 * The five AI factor FILES were deleted with their registrations; git history
 * holds them. estimatedCvd.ts is kept, because it is hand-written and carries
 * its own regression test — it is simply no longer registered.
 *
 * ONE LIMITATION, stated because it bounds the whole exercise: OPTIONS and
 * CATALYST factors go silent on historical dates, so the audit says NOTHING
 * about them and none was touched. Their track record remains unmeasured.
 */
import type { PredictiveFactor } from './types.js';
import { VolumeProfileFactor } from './volumeProfile.js';
import { AtrVolatilityFactor } from './atrVolatility.js';
import { DealerHedgingFactor } from './dealerHedging.js';
import { AnchoredVwapFactor } from './anchoredVwap.js';
import { SessionVwapFactor } from './sessionVwap.js';
import { SwingStructureFactor } from './swingStructure.js';
import { HvlrSupportFactor } from './hvlrSupport.js';
import { OptionsSqueezeFactor } from './squeezeScore.js';
import { RiskReversalSkewFactor } from './riskReversalSkew.js';
import { TermStructureFactor } from './termStructure.js';
import { HurstExponentFactor } from './hurstExponent.js';
import { KamaZScoreFactor } from './kamaZScore.js';
import { InsiderCatalystFactor } from './insiderCatalyst.js';
import { PositioningSentimentFactor } from './positioningSentiment.js';
import { IvRvRatioFactor } from './ivRvRatio.js';
import { MaxPainDriftFactor } from './maxPainDrift.js';
import { VannaDeltaPressureFactor } from './vannaDeltaPressure.js';
import { SmartMoneyFlowFactor } from './smartMoneyFlow.js';
import { RelativeMomentumFactor } from './relativeMomentum.js';

// DO NOT REMOVE THIS LINE. AI QUANT USES IT TO INJECT NEW FACTORS.
// [AI_QUANT_IMPORTS_END]

export function getFactors(): PredictiveFactor[] {
  return [
    new VolumeProfileFactor(),
    new AtrVolatilityFactor(),
    new DealerHedgingFactor(),
    new AnchoredVwapFactor(),
    new SessionVwapFactor(),
    new SwingStructureFactor(),
    new HvlrSupportFactor(),
    new OptionsSqueezeFactor(),
    new RiskReversalSkewFactor(),
    new TermStructureFactor(),
    new HurstExponentFactor(),
    new KamaZScoreFactor(),
    new InsiderCatalystFactor(),
    new PositioningSentimentFactor(),
    new IvRvRatioFactor(),
    new MaxPainDriftFactor(),
    new VannaDeltaPressureFactor(),
    new SmartMoneyFlowFactor(),
    new RelativeMomentumFactor(),
    // DO NOT REMOVE THIS LINE. AI QUANT USES IT TO INJECT NEW FACTORS.
    // [AI_QUANT_FACTOR_INSTANCES_END]
  ];
}
