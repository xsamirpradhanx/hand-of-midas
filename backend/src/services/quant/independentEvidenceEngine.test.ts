import { describe, it, expect } from 'vitest';
import { calculateIndependentEvidence } from './independentEvidenceEngine.js';
import type { FactorResult } from '../factors/types.js';

const f = (over: Partial<FactorResult>): FactorResult => ({
  factorName: 'F',
  bias: 'neutral',
  weight: 0.2,
  bucket: 'PRICE_STRUCTURE',
  reasoning: '',
  ...over,
});

describe('calculateIndependentEvidence — non-voting factors', () => {
  it('excludes a never-voting factor from the directional denominator', () => {
    const voters = [
      f({ factorName: 'A', bias: 'bullish', weight: 0.35, correlationGroup: 'A' }),
      f({ factorName: 'B', bias: 'bullish', weight: 0.30, correlationGroup: 'B' }),
    ];
    const levelProvider = f({
      factorName: 'Swing', bias: 'neutral', weight: 0.38,
      correlationGroup: 'SWING', directional: false,
    });

    const withoutIt = calculateIndependentEvidence(voters);
    const withIt = calculateIndependentEvidence([...voters, levelProvider]);

    // A pure level provider must not move the vote at all.
    expect(withIt.evidenceByBucket.PRICE_STRUCTURE!.score)
      .toBeCloseTo(withoutIt.evidenceByBucket.PRICE_STRUCTURE!.score, 6);
  });

  it('still lets a genuine abstention dilute — "no edge" is real evidence', () => {
    const voters = [
      f({ factorName: 'A', bias: 'bullish', weight: 0.35, correlationGroup: 'A' }),
      f({ factorName: 'B', bias: 'bullish', weight: 0.30, correlationGroup: 'B' }),
    ];
    // Can vote (no `directional: false`) but saw nothing this bar.
    const abstained = f({ factorName: 'KAMA', bias: 'neutral', weight: 0.20, correlationGroup: 'KAMA' });

    const withoutIt = calculateIndependentEvidence(voters);
    const withIt = calculateIndependentEvidence([...voters, abstained]);

    expect(withIt.evidenceByBucket.PRICE_STRUCTURE!.score)
      .toBeLessThan(withoutIt.evidenceByBucket.PRICE_STRUCTURE!.score);
  });

  it('reproduces the ~31% understatement the fix removes', () => {
    // Mirrors the live PRICE_STRUCTURE shape measured on NVDA/GLD/AAPL.
    const measured = [
      f({ factorName: 'VolumeProfile', bias: 'bullish', weight: 0.35, correlationGroup: 'VP' }),
      f({ factorName: 'AnchoredVWAP', bias: 'bullish', weight: 0.30, correlationGroup: 'AVWAP' }),
      f({ factorName: 'HVLR', bias: 'bullish', weight: 0.20, correlationGroup: 'HVLR' }),
      f({ factorName: 'Swing', bias: 'neutral', weight: 0.38, correlationGroup: 'SWING', directional: false }),
    ];
    const score = calculateIndependentEvidence(measured).evidenceByBucket.PRICE_STRUCTURE!.score;
    // All three voters agree, so with the non-voter removed this is unanimous.
    expect(score).toBeCloseTo(1.0, 6);
  });

  it('returns empty evidence when every factor is a non-voter', () => {
    const ev = calculateIndependentEvidence([
      f({ factorName: 'Swing', weight: 0.38, directional: false }),
      f({ factorName: 'ATR', weight: 0.25, bucket: 'POSITIONING', directional: false }),
    ]);
    expect(ev.pluralityBias).toBe('neutral');
    expect(ev.bullishScore).toBe(0);
    expect(ev.bearishScore).toBe(0);
    expect(ev.evidenceByBucket).toEqual({});
  });

  it('treats a factor with directional undefined as a voter (backwards compatible)', () => {
    const ev = calculateIndependentEvidence([
      f({ factorName: 'A', bias: 'bullish', weight: 0.3, correlationGroup: 'A' }),
      f({ factorName: 'B', bias: 'bearish', weight: 0.3, correlationGroup: 'B' }),
    ]);
    expect(ev.bullishScore).toBeGreaterThan(0);
    expect(ev.bearishScore).toBeGreaterThan(0);
  });
});
