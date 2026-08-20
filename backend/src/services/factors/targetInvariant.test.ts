import { describe, it, expect } from 'vitest';
import { getFactors } from './factorRegistry.js';
import type { FactorInput, FactorResult } from './types.js';

/**
 * Engine-wide invariant: buyTarget is a SUPPORT level, sellTarget is RESISTANCE.
 *
 * compositeScore.ts bins each emitted target into supportLevels/resistanceLevels
 * purely by comparing it to spot, so a factor that emits them the wrong way round
 * feeds its upside target into the support cluster and its downside into
 * resistance.
 *
 * Note the gate at compositeScore.ts:342: only PRICE_STRUCTURE-bucketed factors
 * (or names in PRICE_LOCATION_FACTOR_NAMES) reach clustering at all, so a
 * MOMENTUM factor's inverted targets are latent rather than actively corrupting.
 * This is asserted engine-wide anyway — the contract should hold for every
 * factor regardless of how it happens to be routed today, since routing changes.
 *
 * This is checked as an ORDERING (buyTarget <= sellTarget) rather than "which
 * side of spot each sits on". A band-based factor legitimately has both bands
 * below spot when price is extended above them — Anchored VWAP does exactly that
 * — and that is not an inversion.
 *
 * Caught live: AsymmetricKinematicEfficiencyFactor (AI-generated) shipped with
 * buyTarget > sellTarget on its entire bullish path and passed every existing
 * gate. All nine hand-written target-emitting factors were clean.
 *
 * Deterministic synthetic bars only — no network, no options chain. Factors that
 * need data we do not supply return null and are skipped.
 */
type Regime = 'oscillating' | 'uptrend' | 'downtrend';

function syntheticBars(length: number, regime: Regime): FactorInput['bars'] {
  const bars: FactorInput['bars'] = [];
  let price = 100;
  for (let i = 0; i < length; i++) {
    const wobble = Math.sin(i / 7) * 1.5 + Math.cos(i / 3) * 0.5;
    const trend = regime === 'uptrend' ? 0.8 : regime === 'downtrend' ? -0.8 : 0;
    const drift = wobble + trend;
    const open = price;
    const close = Math.max(1, price + drift);
    bars.push({
      datetime: new Date(Date.UTC(2024, 0, i + 1)).toISOString(),
      open,
      high: Math.max(open, close) + Math.abs(drift) * 0.5 + 0.25,
      low: Math.min(open, close) - Math.abs(drift) * 0.5 - 0.25,
      close,
      volume: 1_000_000 + (i % 11) * 150_000,
    });
    price = close;
  }
  return bars;
}

const REGIMES: Regime[] = ['oscillating', 'uptrend', 'downtrend'];

/**
 * Sweeping the series LENGTH matters as much as the regime.
 *
 * A directional factor reads whichever way the tail of the series happens to
 * point, and an inversion bug only manifests on the branch it corrupts. The
 * first version of this test used 120 bars only, where the offending factor
 * reads bearish (its correct branch) on all three regimes — so the test passed
 * vacuously while the bug was live. At 60 and 100 bars the same factor reads
 * bullish and the violation appears. Sweep lengths so both branches are hit.
 */
const LENGTHS = [60, 80, 100, 120];

describe('factor target invariant: buyTarget <= sellTarget', () => {
  for (const regime of REGIMES) {
    for (const length of LENGTHS) {
    it(`holds for every registered factor (${regime}, ${length} bars)`, async () => {
      const bars = syntheticBars(length, regime);
      const input: FactorInput = {
        symbol: 'TEST',
        currentPrice: bars[bars.length - 1].close,
        bars,
      };

      const violations: string[] = [];
      for (const factor of getFactors()) {
        let result: FactorResult | null;
        try {
          result = await factor.evaluate(input);
        } catch {
          // A factor that needs inputs this harness does not supply may throw;
          // that is covered by the factor-doctor script, not this invariant.
          continue;
        }
        if (!result) continue;

        const { buyTarget, sellTarget } = result;
        if (typeof buyTarget !== 'number' || typeof sellTarget !== 'number') continue;

        if (!Number.isFinite(buyTarget) || !Number.isFinite(sellTarget)) {
          violations.push(`${factor.name}: non-finite target (buy=${buyTarget}, sell=${sellTarget})`);
        } else if (buyTarget > sellTarget) {
          violations.push(
            `${factor.name}: buyTarget ${buyTarget.toFixed(2)} > sellTarget ${sellTarget.toFixed(2)} (bias=${result.bias})`,
          );
        }
      }

      expect(violations).toEqual([]);
    });
    }
  }
});
