import { describe, it, expect } from 'vitest';
import { buildPanelSet, forwardReturns, scoreCandidate } from './indicatorLab.js';
import { shuffleForwardWithinDates } from './indicatorSearch.js';
import { Rng, randomExpr, render, evaluate, mutate, crossover } from './indicatorGrammar.js';
import type { IndicatorCandidate } from './indicatorLab.js';
import type { BarPanel } from '../backtest/barCache.js';

const DAY = 86_400_000;

function panelOf(symbol: string, n: number, seed: number): BarPanel {
  let s = seed >>> 0, p = 100;
  const c: number[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    p *= 1 + (s / 4294967296 - 0.5) * 0.03;
    c.push(p);
  }
  const mk = (f: (i: number) => number) => Float64Array.from({ length: n }, (_, i) => f(i));
  return {
    symbol, n,
    t: mk(i => Date.parse('2000-01-03') + i * DAY),
    o: mk(i => c[i] * 0.999), h: mk(i => c[i] * 1.01),
    l: mk(i => c[i] * 0.99), c: mk(i => c[i]), v: mk(i => 1e6 + i),
  };
}

const panels = Array.from({ length: 30 }, (_, k) => panelOf(`S${k}`, 2600, 11 + k));
const set = buildPanelSet(panels, 'S0', 'NONE');
const fwd = panels.map(p => forwardReturns(p, 20));

describe('shuffleForwardWithinDates', () => {
  it('preserves each date\'s return multiset while breaking the pairing', () => {
    const shuffled = shuffleForwardWithinDates(set, fwd, new Rng(9));
    const gather = (arrs: readonly Float64Array[], d: number) => {
      const out: number[] = [];
      for (let s = 0; s < set.panels.length; s++) {
        for (let i = 0; i < set.panels[s].n; i++) {
          if (set.dateIndex[s][i] === d && Number.isFinite(arrs[s][i])) out.push(arrs[s][i]);
        }
      }
      return out.sort((x, y) => x - y);
    };
    for (const d of [500, 1200, 2000]) {
      expect(gather(shuffled, d)).toEqual(gather(fwd, d));
    }
    // and it actually moved something
    let moved = 0;
    for (let s = 0; s < set.panels.length; s++) {
      for (let i = 0; i < set.panels[s].n; i++) if (fwd[s][i] !== shuffled[s][i]) moved++;
    }
    expect(moved).toBeGreaterThan(1000);
  });
});

describe('grammar', () => {
  it('renders structurally equal trees to equal strings, for deduplication', () => {
    const rng = new Rng(1);
    const e = randomExpr(rng, 4);
    expect(render(e)).toBe(render(JSON.parse(JSON.stringify(e))));
  });

  it('mutation and crossover keep the tree evaluable', () => {
    const rng = new Rng(77);
    const market = {
      dates: set.dates, benchClose: set.benchClose, benchRet: set.benchRet,
      vixClose: set.vixClose, dateIndexOf: set.dateIndex[0],
    };
    for (let k = 0; k < 30; k++) {
      const a = randomExpr(rng, 4), b = randomExpr(rng, 4);
      for (const e of [mutate(a, rng, 4), crossover(a, b, rng)]) {
        const out = evaluate(e, panels[0], market);
        expect(out.length).toBe(panels[0].n);
        for (const v of out) expect(Number.isNaN(v) || Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('never produces an infinite value from a guarded division', () => {
    const rng = new Rng(5);
    const market = {
      dates: set.dates, benchClose: set.benchClose, benchRet: set.benchRet,
      vixClose: set.vixClose, dateIndexOf: set.dateIndex[0],
    };
    for (let k = 0; k < 60; k++) {
      for (const v of evaluate(randomExpr(rng, 4), panels[0], market)) {
        expect(v === Infinity || v === -Infinity).toBe(false);
      }
    }
  });
});

describe('crossSectionalShare', () => {
  const opts = { horizon: 20, minCrossSection: 10, activeFraction: 1, bootstrapIterations: 0 };

  /**
   * The guard that stopped the search returning `mean63(benchRet)` at t = -4.3.
   *
   * A series identical for every symbol on a date cannot rank them: whatever
   * ordering appears is an artefact of each symbol's own history and z-score
   * window. IC cannot see the difference, so this metric has to.
   */
  it('is ~0 for a signal that is the same for every symbol on a date', () => {
    const marketWide: IndicatorCandidate = {
      name: 'market-wide', family: 'test', warmup: 5,
      compute: (panel, market) => {
        const out = new Float64Array(panel.n).fill(NaN);
        for (let i = 0; i < panel.n; i++) {
          const d = market.dateIndexOf[i];
          // A pure function of the DATE — no symbol-specific content at all.
          if (d >= 0) out[i] = Math.sin(d / 11);
        }
        return out;
      },
    };
    const s = scoreCandidate(marketWide, set, fwd, opts);
    // A PERFECTLY market-wide signal ranks every symbol equal, so no date has a
    // defined correlation and nothing is scorable: dates 0, share NaN. The
    // search rejects it through `>= min`, which NaN fails.
    expect(s.dates).toBe(0);
    expect(Number.isNaN(s.crossSectionalShare)).toBe(true);
  });

  it('is ~0 for a signal that is ALMOST the same for every symbol', () => {
    // The realistic case, and the one that actually got through: a market-wide
    // series still varies a little between symbols, because each carries its
    // own bars and its own trailing z-score window. That tiny variation is
    // enough to make dates scorable — `mean63(benchRet)` scored t = -4.3 on it
    // — so the share has to be near zero rather than undefined.
    const almost: IndicatorCandidate = {
      name: 'almost-market-wide', family: 'test', warmup: 5,
      compute: (panel, market) => {
        const out = new Float64Array(panel.n).fill(NaN);
        let seed = panel.symbol.length * 7919;
        for (let i = 0; i < panel.n; i++) {
          const d = market.dateIndexOf[i];
          seed = (seed * 1103515245 + 12345) % 2147483648;
          if (d >= 0) out[i] = Math.sin(d / 11) + (seed / 2147483648 - 0.5) * 1e-3;
        }
        return out;
      },
    };
    const s = scoreCandidate(almost, set, fwd, opts);
    expect(s.dates).toBeGreaterThan(100);
    expect(s.crossSectionalShare).toBeLessThan(0.05);
  });

  it('is ~1 for a signal driven by each symbol\'s own series', () => {
    const idiosyncratic: IndicatorCandidate = {
      name: 'idio', family: 'test', warmup: 30,
      compute: panel => {
        const out = new Float64Array(panel.n).fill(NaN);
        for (let i = 21; i < panel.n; i++) out[i] = panel.c[i] / panel.c[i - 21] - 1;
        return out;
      },
    };
    const s = scoreCandidate(idiosyncratic, set, fwd, opts);
    expect(s.crossSectionalShare).toBeGreaterThan(0.7);
  });

  /**
   * Adding a market-wide component to an idiosyncratic signal must LOWER the
   * share, monotonically — otherwise the metric would not order the mixed cases
   * that a search actually produces.
   */
  it('falls as a market-wide component is mixed in', () => {
    const mixed = (marketWeight: number): IndicatorCandidate => ({
      name: `mix${marketWeight}`, family: 'test', warmup: 30,
      compute: (panel, market) => {
        const out = new Float64Array(panel.n).fill(NaN);
        for (let i = 21; i < panel.n; i++) {
          const d = market.dateIndexOf[i];
          const own = panel.c[i] / panel.c[i - 21] - 1;
          out[i] = (1 - marketWeight) * own + marketWeight * Math.sin(d / 11) * 0.1;
        }
        return out;
      },
    });
    const shares = [0, 0.5, 0.95].map(w => scoreCandidate(mixed(w), set, fwd, opts).crossSectionalShare);
    expect(shares[0]).toBeGreaterThan(shares[1]);
    expect(shares[1]).toBeGreaterThan(shares[2]);
  });
});
