import { describe, it, expect } from 'vitest';
import { CompositeScoreAgent } from '../compositeScore.js';
import { getFactors } from '../factors/factorRegistry.js';
import type { FactorInput } from '../factors/types.js';
import type { OHLCVDataPoint } from '../../types.js';

/**
 * The learning key must carry the setup type and nothing else.
 *
 * `archetype` is persisted as `setupType` by routes/predictive.ts and is what
 * SETUP_STATS is keyed on. Advisory annotations used to be appended to it —
 * `Mean Reversion [LOW QUALITY]` — which forked each archetype into a separate
 * statistical population: 4 keys became 8 over 13,720 replayed trades, 18.7% of
 * trades landed in a split key, and the thinnest held 238. Live it is worse,
 * since the Trade Plan writes once per day per symbol and HIGH SQUEEZE RISK
 * splits again.
 *
 * The annotation is also not measuring what its name claims. `LOW QUALITY`
 * fires on evidence DISAGREEMENT, and those setups measured better, not worse
 * (+0.1852R against +0.1256R, better in every symbol x era cell) — though not
 * by an established margin. Either way it must not fragment the keyspace, and a
 * future edit that re-appends it would restore the fragmentation silently,
 * because nothing else in the system would notice.
 */
function bars(n: number): OHLCVDataPoint[] {
  const out: OHLCVDataPoint[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 9) * 2.5 + Math.cos(i / 4) * 0.8;
    const open = price;
    const close = Math.max(1, price + drift);
    out.push({
      datetime: new Date(Date.UTC(2024, 0, i + 1)).toISOString(),
      open,
      high: Math.max(open, close) + Math.abs(drift) * 0.6 + 0.3,
      low: Math.min(open, close) - Math.abs(drift) * 0.6 - 0.3,
      close,
      volume: 1_000_000 + (i % 13) * 120_000,
    } as OHLCVDataPoint);
    price = close;
  }
  return out;
}

async function plan(seedShift: number) {
  const series = bars(300).map((b, i) => ({ ...b, close: b.close + seedShift * Math.sin(i / 5) }));
  const input = {
    symbol: 'TEST', currentPrice: series[series.length - 1].close, bars: series,
    benchmarkBars: bars(300),
  } as FactorInput;
  const results = [];
  for (const f of getFactors()) {
    try { const r = await f.evaluate(input); if (r) results.push(r); } catch { /* abstains */ }
  }
  const synth = await new CompositeScoreAgent().synthesize(
    'TEST', input.currentPrice, results, series as any, undefined,
  );
  return (synth as any).tradePlan;
}

describe('setup key hygiene', () => {
  it('never embeds an advisory in the archetype', async () => {
    for (const shift of [0, 1, 2, 3, 5, 8]) {
      const tp = await plan(shift);
      if (!tp) continue;
      expect(tp.archetype, `archetype must stay a bare setup type, got "${tp.archetype}"`)
        .not.toMatch(/[[\]]/);
      expect(tp.archetype).not.toMatch(/LOW QUALITY|SQUEEZE RISK/);
    }
  });

  it('exposes advisories as their own field', async () => {
    const tp = await plan(0);
    expect(tp).toBeDefined();
    expect(Array.isArray(tp.advisories)).toBe(true);
    for (const a of tp.advisories) expect(typeof a).toBe('string');
  });

  it('keeps the archetype set small enough for a key to accumulate a sample', async () => {
    const seen = new Set<string>();
    for (const shift of [0, 1, 2, 3, 5, 8, 13, 21]) {
      const tp = await plan(shift);
      if (tp?.archetype) seen.add(tp.archetype);
    }
    // A handful of structural archetypes, not one per evidence permutation.
    expect(seen.size).toBeLessThanOrEqual(6);
  });
});
