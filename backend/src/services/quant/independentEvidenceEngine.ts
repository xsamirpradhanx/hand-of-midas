/**
 * IndependentEvidenceEngine
 *
 * Solves: Old CompositeScoreAgent treated every factor as an independent vote,
 * so GEX + Vanna + MaxPain + Squeeze counted as 4 independent bullish signals
 * even though they all measure the same GEX_COMPLEX phenomenon.
 *
 * Solution:
 * 1. Group factors by bucket (PRICE_STRUCTURE, ORDER_FLOW, OPTIONS, etc.)
 * 2. Within each bucket, group by correlationGroup
 * 3. Per correlation group → take the highest-weight representative (not sum)
 * 4. Per bucket → weighted average of de-duplicated group representatives
 * 5. signalAgreement = fraction of active buckets aligned with plurality bias
 */

import type { FactorResult, FactorBucket } from '../factors/types.js';

export interface BucketEvidence {
  bucket: FactorBucket;
  bias: 'bullish' | 'bearish' | 'neutral';
  /** Signed score: positive = bullish, negative = bearish. Range -1 to +1. */
  score: number;
  /** Confidence 0-1. */
  confidence: number;
  contributingFactors: string[];
  groupCount: number;
}

export interface IndependentEvidence {
  evidenceByBucket: Partial<Record<FactorBucket, BucketEvidence>>;
  bullishScore: number;
  bearishScore: number;
  neutralScore: number;
  netBias: number;
  signalAgreement: number;
  agreementLevel: 'HIGH' | 'MODERATE' | 'LOW';
  pluralityBias: 'bullish' | 'bearish' | 'neutral';
}

const BUCKET_WEIGHTS: Record<FactorBucket, number> = {
  PRICE_STRUCTURE: 1.2,
  ORDER_FLOW:      1.1,
  OPTIONS:         1.0,
  CATALYST:        0.9,
  POSITIONING:     0.7,
  MOMENTUM:        0.6,
  LIQUIDITY:       0.5,
};

export function calculateIndependentEvidence(factors: FactorResult[]): IndependentEvidence {
  const empty: IndependentEvidence = {
    evidenceByBucket: {},
    bullishScore: 0, bearishScore: 0, neutralScore: 0,
    netBias: 0, signalAgreement: 0,
    agreementLevel: 'LOW', pluralityBias: 'neutral',
  };
  if (!factors || factors.length === 0) return empty;

  // Group by bucket then by correlationGroup
  const byBucket = new Map<FactorBucket, Map<string, FactorResult[]>>();
  for (const f of factors) {
    const bucket = f.bucket ?? 'MOMENTUM';
    const group = f.correlationGroup ?? f.factorName;
    if (!byBucket.has(bucket)) byBucket.set(bucket, new Map());
    const bucketMap = byBucket.get(bucket)!;
    if (!bucketMap.has(group)) bucketMap.set(group, []);
    bucketMap.get(group)!.push(f);
  }

  const evidenceByBucket: Partial<Record<FactorBucket, BucketEvidence>> = {};
  let totalBullish = 0;
  let totalBearish = 0;
  let totalNeutral = 0;

  for (const [bucket, groupMap] of byBucket.entries()) {
    const bucketMultiplier = BUCKET_WEIGHTS[bucket] ?? 1.0;

    // Per correlation group — pick highest-weight representative
    const representatives: FactorResult[] = [];
    const names: string[] = [];
    for (const groupFactors of groupMap.values()) {
      const best = groupFactors.reduce((a, b) => b.weight > a.weight ? b : a);
      representatives.push(best);
      names.push(best.factorName);
    }

    let bullW = 0, bearW = 0, neutW = 0, totalW = 0;
    for (const rep of representatives) {
      const w = rep.weight * bucketMultiplier;
      totalW += w;
      if (rep.bias === 'bullish') bullW += w;
      else if (rep.bias === 'bearish') bearW += w;
      else neutW += w;
    }
    if (totalW === 0) continue;

    const score = (bullW - bearW) / totalW;
    const bias: 'bullish' | 'bearish' | 'neutral' =
      score > 0.15 ? 'bullish' : score < -0.15 ? 'bearish' : 'neutral';

    evidenceByBucket[bucket] = {
      bucket, bias,
      score: Number(score.toFixed(3)),
      confidence: Number(Math.min(1, Math.abs(score) * 2).toFixed(3)),
      contributingFactors: names,
      groupCount: representatives.length,
    };

    totalBullish += bullW;
    totalBearish += bearW;
    totalNeutral += neutW;
  }

  const pluralityBias: 'bullish' | 'bearish' | 'neutral' =
    totalBullish > totalBearish ? 'bullish' :
    totalBearish > totalBullish ? 'bearish' : 'neutral';

  const activeBuckets = Object.values(evidenceByBucket).filter(b => b.bias !== 'neutral');
  const agreeing = activeBuckets.filter(b => b.bias === pluralityBias).length;
  const signalAgreement = activeBuckets.length > 0 ? agreeing / activeBuckets.length : 0;
  const agreementLevel: 'HIGH' | 'MODERATE' | 'LOW' =
    signalAgreement >= 0.75 ? 'HIGH' : signalAgreement >= 0.5 ? 'MODERATE' : 'LOW';

  return {
    evidenceByBucket,
    bullishScore: Number(totalBullish.toFixed(3)),
    bearishScore: Number(totalBearish.toFixed(3)),
    neutralScore: Number(totalNeutral.toFixed(3)),
    netBias: Number((totalBullish - totalBearish).toFixed(3)),
    signalAgreement: Number(signalAgreement.toFixed(3)),
    agreementLevel,
    pluralityBias,
  };
}
