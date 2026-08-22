import { describe, it, expect } from 'vitest';
import { getFactors } from './factorRegistry.js';
import type { FactorInput, FactorResult } from './types.js';

/**
 * Guards the 2026-08-21 pruning, in both directions.
 *
 * Six factors were removed after `npm run factor-audit` measured their
 * informedness — P(up | bullish) minus P(up | bearish) — at or below zero over
 * 390,733 decision bars, AND confirmed that none of their price levels ever
 * reached zone clustering. Replayed end to end the removal improved every book.
 *
 * The more valuable half of this file is the SECOND assertion. Volume Profile,
 * Anchored VWAP and HVLR Support score just as badly on informedness, and
 * silencing them looked like the obvious next step. It was tried and reverted:
 * per-trade expectancy rose (+39% on the LONG book) while return-per-drawdown
 * fell from 30.98 to 25.41, drawdown having more than doubled at matched trade
 * volume and matched long/short mix.
 *
 * Their uninformative votes DECORRELATE the book. Remove them and the engine
 * reaches the same read across many symbols at once and piles into one side
 * together — better trades, riskier portfolio. Anyone reading the audit table
 * alone will reach for `directional: false` on these three, so the reason not
 * to is asserted here rather than left in a commit message.
 */
function syntheticBars(length: number): FactorInput['bars'] {
  const bars: FactorInput['bars'] = [];
  let price = 100;
  for (let i = 0; i < length; i++) {
    const drift = Math.sin(i / 7) * 1.5 + Math.cos(i / 3) * 0.5;
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

/**
 * `benchmarkBars` is supplied because Relative Momentum abstains without it,
 * and abstention would make the "still votes" assertions pass vacuously — a
 * test that could not fail if the factor were silently unregistered.
 */
function input(): FactorInput {
  const bars = syntheticBars(300);
  const benchmarkBars = syntheticBars(300).map((b, i) => ({
    ...b,
    close: 100 + i * 0.05, open: 100 + i * 0.05,
    high: 100.5 + i * 0.05, low: 99.5 + i * 0.05,
  }));
  return { symbol: 'TEST', currentPrice: bars[bars.length - 1].close, bars, benchmarkBars } as FactorInput;
}

async function evaluateAll(): Promise<FactorResult[]> {
  const out: FactorResult[] = [];
  for (const f of getFactors()) {
    try {
      const r = await f.evaluate(input());
      if (r) out.push(r);
    } catch { /* factors needing data this fixture omits abstain */ }
  }
  return out;
}

const REMOVED = [
  'Estimated CVD (Bar-Position Delta)',
  'Volume Information Entropy Imbalance',
  'Volume Synchronized Entropy Divergence',
  'Spectral Microstructure Inertia',
  'Fractal Efficiency Liquidity Sweep',
  'Asymmetric Kinematic Efficiency',
];

/** Uninformative by measurement, kept anyway — see the file header. */
const KEPT_DESPITE_ZERO_INFORMEDNESS = ['Volume Profile', 'Anchored VWAP', 'High-Volume Low-Range'];

describe('factor pruning', () => {
  it('the six removed factors are not registered', () => {
    const names = getFactors().map(f => f.name);
    for (const gone of REMOVED) expect(names).not.toContain(gone);
  });

  it('keeps the uninformative level providers VOTING, because silencing them measured worse', async () => {
    const results = await evaluateAll();
    for (const label of KEPT_DESPITE_ZERO_INFORMEDNESS) {
      const r = results.find(x => x.factorName.includes(label));
      expect(r, `${label} should still be registered and reporting`).toBeDefined();
      // The whole point: a poor informedness score is NOT grounds to stop
      // voting. Only a structural absence of direction is.
      expect(r!.directional, `${label} must keep voting — see factorPruning.test.ts header`).not.toBe(false);
    }
  });

  it('keeps the two factors that measured positive voting', async () => {
    const voters = (await evaluateAll()).filter(r => r.directional !== false).map(r => r.factorName);
    expect(voters.some(n => n.includes('KAMA'))).toBe(true);
    expect(voters.some(n => n.includes('Relative Momentum'))).toBe(true);
  });

  it('still routes the kept level providers into zone clustering', async () => {
    // compositeScore only reads levels from PRICE_STRUCTURE factors and a short
    // named list. These three are registered FOR their levels, so a bucket
    // change would quietly make them contribute nothing.
    const results = await evaluateAll();
    for (const label of KEPT_DESPITE_ZERO_INFORMEDNESS) {
      const r = results.find(x => x.factorName.includes(label))!;
      expect(r.bucket).toBe('PRICE_STRUCTURE');
      const levels = [
        ...(r.buyTarget !== undefined ? [r.buyTarget] : []),
        ...(r.sellTarget !== undefined ? [r.sellTarget] : []),
        ...(r.levels ?? []).map(l => l.price),
      ].filter(p => Number.isFinite(p) && p > 0);
      expect(levels.length, `${label} must emit at least one level`).toBeGreaterThan(0);
    }
  });
});
