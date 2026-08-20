import { describe, it, expect } from 'vitest';
import { replay } from './replayEngine.js';
import type { BacktestBar, BacktestDataSource, BacktestStrategy } from './types.js';

/** Deterministic synthetic series: no Math.random, so failures are reproducible. */
function series(n: number, priceAt: (i: number) => number, start = '2020-01-01'): BacktestBar[] {
  const out: BacktestBar[] = [];
  for (let i = 0; i < n; i++) {
    const p = priceAt(i);
    out.push({
      datetime: new Date(Date.parse(start + 'T00:00:00Z') + i * 86_400_000).toISOString(),
      open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1_000_000,
    });
  }
  return out;
}

function source(map: Record<string, BacktestBar[]>): BacktestDataSource {
  return {
    symbols: async () => Object.keys(map),
    bars: async (s) => map[s] ?? [],
  };
}

const HORIZON = 20;
const WARMUP = 5;

describe('replay — look-ahead prevention', () => {
  it('never shows a strategy a bar at or beyond its decision point', async () => {
    const bars = series(200, i => 100 + i);
    let maxSeen = -Infinity;
    let violations = 0;

    const spy: BacktestStrategy = {
      name: 'spy',
      plan(ctx) {
        const last = ctx.bars[ctx.bars.length - 1];
        // The visible window must end exactly at asOf, never later.
        if (last.datetime !== ctx.asOf) violations++;
        maxSeen = Math.max(maxSeen, Date.parse(last.datetime));
        if (Date.parse(last.datetime) > Date.parse(ctx.asOf)) violations++;
        return null;
      },
    };

    await replay(source({ X: bars }), spy, { warmupBars: WARMUP, horizonBars: HORIZON });
    expect(violations).toBe(0);
  });

  it('hands the strategy a frozen copy it cannot mutate into future state', async () => {
    const bars = series(120, () => 100);
    let mutationThrew = false;

    const vandal: BacktestStrategy = {
      name: 'vandal',
      plan(ctx) {
        try {
          (ctx.bars as BacktestBar[]).push({
            datetime: '2099-01-01T00:00:00Z', open: 1, high: 1, low: 1, close: 1, volume: 1,
          });
        } catch {
          mutationThrew = true;
        }
        try {
          (ctx.bars[0] as { close: number }).close = 99999;
        } catch {
          mutationThrew = true;
        }
        return null;
      },
    };

    await replay(source({ X: bars }), vandal, { warmupBars: WARMUP, horizonBars: HORIZON });
    expect(mutationThrew).toBe(true);
  });

  it('a strategy that only sees the past cannot beat a pure random walk into profit', async () => {
    // Deterministic zig-zag with no exploitable drift.
    const bars = series(400, i => 100 + (i % 2 === 0 ? 1 : -1));
    const alwaysLong: BacktestStrategy = {
      name: 'always-long',
      plan: (ctx) => {
        const p = ctx.bars[ctx.bars.length - 1].close;
        return { bias: 'LONG', entry: p, stop: p * 0.95, target: p * 1.05 };
      },
    };
    const res = await replay(source({ X: bars }), alwaysLong, { warmupBars: WARMUP, horizonBars: HORIZON });
    // Never reaches +/-5% on a +/-1 oscillation, so everything must time out flat.
    expect(res.stats.wins).toBe(0);
    expect(Math.abs(res.stats.totalR)).toBeLessThan(res.stats.resolved * 0.5);
  });
});

describe('replay — grading and accounting', () => {
  it('books a win on a clean uptrend and reports positive expectancy', async () => {
    const bars = series(200, i => 100 * Math.pow(1.01, i)); // +1%/bar
    const longs: BacktestStrategy = {
      name: 'longs',
      plan: (ctx) => {
        const p = ctx.bars[ctx.bars.length - 1].close;
        return { bias: 'LONG', entry: p, stop: p * 0.95, target: p * 1.05 };
      },
    };
    const res = await replay(source({ X: bars }), longs, { warmupBars: WARMUP, horizonBars: HORIZON });

    expect(res.stats.total).toBeGreaterThan(0);
    expect(res.stats.winRate).toBe(1);
    expect(res.stats.expectancyR!).toBeGreaterThan(0);
    expect(res.stats.maxDrawdownR).toBe(0);
  });

  it('books losses on a clean downtrend when positioned long', async () => {
    const bars = series(200, i => 100 * Math.pow(0.99, i));
    const longs: BacktestStrategy = {
      name: 'longs',
      plan: (ctx) => {
        const p = ctx.bars[ctx.bars.length - 1].close;
        return { bias: 'LONG', entry: p, stop: p * 0.95, target: p * 1.05 };
      },
    };
    const res = await replay(source({ X: bars }), longs, { warmupBars: WARMUP, horizonBars: HORIZON });
    expect(res.stats.losses).toBeGreaterThan(0);
    expect(res.stats.expectancyR!).toBeLessThan(0);
    expect(res.stats.maxDrawdownR).toBeGreaterThan(0);
  });

  it('respects maxConcurrentPerSymbol so overlapping plans are not double-counted', async () => {
    const bars = series(300, i => 100 * Math.pow(1.01, i));
    const everyBar: BacktestStrategy = {
      name: 'every-bar',
      plan: (ctx) => {
        const p = ctx.bars[ctx.bars.length - 1].close;
        return { bias: 'LONG', entry: p, stop: p * 0.95, target: p * 1.05 };
      },
    };
    const one = await replay(source({ X: bars }), everyBar, { warmupBars: WARMUP, horizonBars: HORIZON, maxConcurrentPerSymbol: 1 });
    const many = await replay(source({ X: bars }), everyBar, { warmupBars: WARMUP, horizonBars: HORIZON, maxConcurrentPerSymbol: 99 });
    expect(one.stats.total).toBeLessThan(many.stats.total);
  });

  it('leaves the tail ungraded rather than grading against a truncated horizon', async () => {
    const bars = series(100, () => 100);
    const always: BacktestStrategy = {
      name: 'always',
      plan: (ctx) => {
        const p = ctx.bars[ctx.bars.length - 1].close;
        return { bias: 'LONG', entry: p, stop: p * 0.9, target: p * 1.1 };
      },
    };
    const res = await replay(source({ X: bars }), always, { warmupBars: WARMUP, horizonBars: HORIZON, maxConcurrentPerSymbol: 99 });
    const lastDecision = Date.parse(res.trades[res.trades.length - 1].asOf);
    const lastBar = Date.parse(bars[bars.length - 1].datetime);
    // Every graded plan must have a full horizon of bars after it.
    expect(lastBar - lastDecision).toBeGreaterThanOrEqual(HORIZON * 86_400_000);
  });

  it('skips symbols with too little history to warm up and grade', async () => {
    const res = await replay(source({ TINY: series(10, () => 100) }), {
      name: 'always',
      plan: (ctx) => ({ bias: 'LONG', entry: 100, stop: 95, target: 105 }),
    }, { warmupBars: WARMUP, horizonBars: HORIZON });
    expect(res.stats.total).toBe(0);
  });
});

describe('replay — factor learning uses directional credit', () => {
  it('rewards the factor that called the direction and penalises the one that did not', async () => {
    const bars = series(300, i => 100 * Math.pow(1.01, i)); // reliably up
    const strat: BacktestStrategy = {
      name: 'two-factors',
      plan: (ctx) => {
        const p = ctx.bars[ctx.bars.length - 1].close;
        return {
          bias: 'LONG',
          entry: p, stop: p * 0.95, target: p * 1.05,
          factors: [
            { factorName: 'RightFactor', bias: 'bullish' },
            { factorName: 'WrongFactor', bias: 'bearish' },
            { factorName: 'AbstainFactor', bias: 'neutral' },
          ],
        };
      },
    };

    const res = await replay(source({ X: bars }), strat, { warmupBars: WARMUP, horizonBars: HORIZON, maxConcurrentPerSymbol: 99 });

    // Both factors rode identical winning trades. Under the old loop they would
    // have identical stats; directional credit must separate them.
    expect(res.factorStats['RightFactor'].sumScore).toBeGreaterThan(0);
    expect(res.factorStats['WrongFactor'].sumScore).toBeLessThan(0);
    expect(res.factorStats['RightFactor'].wins).toBeGreaterThan(res.factorStats['WrongFactor'].wins);

    // A neutral factor makes no claim and must never be scored at all.
    expect(res.factorStats['AbstainFactor']).toBeUndefined();
  });
});
