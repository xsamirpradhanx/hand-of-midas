import 'dotenv/config';
/**
 * Replay the production engine over stored history.
 *
 *   npm run backtest --workspace=backend
 *   SYMS=AAPL,NVDA FROM=2026-01-01 npm run backtest --workspace=backend
 *   ZONES=1 npm run backtest --workspace=backend      # score zone placement on every bar
 *   STEP=5 npm run backtest --workspace=backend       # decide every 5th bar (faster sweep)
 *
 * Cost note: the strategy runs the FULL production factor stack on every decision
 * bar, so one symbol-year is ~250 x 25 factor evaluations. Use SYMS and STEP to
 * keep exploratory runs short; a full-universe run is an overnight job.
 *
 * The replay engine had unit tests but no caller, so it had never actually run.
 * Until it does, every model change is a guess.
 *
 * Reads the DynamoDB bar store, which is the seam the engine was written
 * against: a strategy validated here is validated on the same series the live
 * loop reads. Options/news factors go silent on historical dates, so conviction
 * here is not comparable to live — compare replay against replay.
 */
import { replay } from '../services/backtest/replayEngine.js';
import { DynamoBarDataSource } from '../services/backtest/dynamoDataSource.js';
import { FileBarDataSource, cachedSymbols, readPanel, DEFAULT_CACHE_DIR } from '../services/backtest/barCache.js';
import { loadIntegrityReport, trustedFromMs } from '../services/backtest/barIntegrity.js';
import { CompositeStrategy, COMPOSITE_WARMUP_BARS } from '../services/backtest/compositeStrategy.js';
import { winRate, expectancy } from '../services/quant/learningCore.js';
import fs from 'node:fs';

/**
 * Zone placement is only a regression metric against a LIKE-FOR-LIKE run.
 *
 * Median error depends heavily on which symbols and which period were replayed —
 * a mega-cap decade and a small-cap quarter produce different numbers from the
 * same code. Comparing across universes reports a regression whenever the
 * universe changes, which is worse than reporting nothing.
 *
 * Baselines are therefore keyed by the run's parameters and only compared when
 * those match exactly. Record one with SAVE_BASELINE=1 after a change you have
 * decided is good.
 */
const BASELINE_FILE = new URL('../../backtest-baselines.json', import.meta.url).pathname;

interface Baseline { demand: number | null; supply: number | null; recordedAt: string; plans: number }

function runKey(symbols: string[] | undefined, step: number, zones: boolean): string {
  return JSON.stringify({
    symbols: symbols ? [...symbols].sort() : 'ALL',
    step, zones,
    from: process.env['FROM'] ?? null,
    to: process.env['TO'] ?? null,
  });
}

function loadBaselines(): Record<string, Baseline> {
  try { return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8')); } catch { return {}; }
}

const pct = (x: number | null) => (x === null ? '   n/a' : `${(x * 100).toFixed(1)}%`);
const num = (x: number | null, d = 2) => (x === null ? ' n/a' : x.toFixed(d));

async function main() {
  // Narration is a live LLM round trip per actionable plan. Across thousands of
  // historical bars that bills real money for prose nobody reads and the rate
  // limit throttles the replay. It feeds no graded value.
  process.env['DISABLE_LLM_NARRATIVE'] = '1';

  const symbols = process.env['SYMS']?.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const includeNoTrade = process.env['ZONES'] === '1';
  /**
   * LOCAL=1 replays off the on-disk mirror instead of DynamoDB, with the
   * integrity quarantine applied.
   *
   * Both matter. The mirror turns a multi-minute Dynamo read into a
   * sub-second one, which is what makes an A/B over the same trades practical.
   * The quarantine matters more: a quarter of the Schwab history in the store
   * is dividend-adjusted by subtraction, which drives old prices of long-time
   * payers toward and past zero, and a return divided by a near-zero price is
   * unbounded. Replays over the raw store are dominated by those symbols.
   * Run `npm run export-bars` then `npm run audit-bars` to populate both.
   */
  const useLocal = process.env['LOCAL'] === '1';
  const minBars = COMPOSITE_WARMUP_BARS + 20 + 1;

  let source: DynamoBarDataSource | FileBarDataSource;
  if (useLocal) {
    const integrity = loadIntegrityReport();
    if (!integrity) throw new Error('LOCAL=1 needs bar-integrity.json — run: npm run audit-bars --workspace=backend');
    const universe = (symbols ?? cachedSymbols(DEFAULT_CACHE_DIR, '1day')).filter(sym => {
      const panel = readPanel(DEFAULT_CACHE_DIR, sym, '1day');
      if (!panel) return false;
      const from = trustedFromMs(integrity, sym);
      let usable = 0;
      for (let i = 0; i < panel.n; i++) if (panel.t[i] >= from) usable++;
      return usable >= minBars;
    });
    const quarantined = Object.values(integrity.symbols).filter(v => v.verdict !== 'clean' && v.verdict !== 'unchecked');
    console.log(`LOCAL=1 — replaying the on-disk mirror; ${quarantined.length} symbols have quarantined history`);
    source = new FileBarDataSource({
      symbols: universe, interval: '1day',
      // The quarantine floor is per symbol, so it is applied by trimming each
      // series rather than through the shared `from` bound.
      from: process.env['FROM'], to: process.env['TO'], minBars,
    });
    const inner = source.bars.bind(source);
    source.bars = async (sym: string) => {
      const floor = trustedFromMs(integrity, sym);
      const bars = await inner(sym);
      return Number.isFinite(floor) ? bars.filter(b => Date.parse(b.datetime) >= floor) : bars;
    };
  } else {
    source = new DynamoBarDataSource({
      symbols,
      interval: '1day',
      from: process.env['FROM'],
      to: process.env['TO'],
      // Warmup plus a full grading horizon, or the symbol can never produce a trade.
      minBars,
    });
  }

  process.stderr.write('\nResolving universe from the bar store… ');
  const universe = await source.symbols();
  console.log(`${universe.length} symbol(s) with enough daily history`);
  if (universe.length === 0) {
    console.log('Nothing to replay. Populate the store first: npm run backfill-bars --workspace=backend\n');
    return;
  }
  console.log(`  ${universe.slice(0, 12).join(', ')}${universe.length > 12 ? ` … +${universe.length - 12} more` : ''}`);
  if (includeNoTrade) console.log('ZONES=1 — emitting NO TRADE bars to score zone placement (expectancy is meaningless in this mode)');
  console.log('');

  // Progress reporting: the strategy is expensive enough that a silent multi-
  // minute run is indistinguishable from a hang.
  let planned = 0;
  const strategy = new CompositeStrategy({ includeNoTrade });
  const step = Number(process.env['STEP'] ?? 1);
  const instrumented = {
    name: strategy.name,
    plan: async (ctx: Parameters<typeof strategy.plan>[0]) => {
      const p = await strategy.plan(ctx);
      if (p && ++planned % 250 === 0) process.stderr.write(`\r  ${planned} plans…`);
      return p;
    },
  };

  const started = Date.now();
  const result = await replay(source, instrumented, {
    warmupBars: COMPOSITE_WARMUP_BARS,
    horizonBars: 20,
    from: process.env['FROM'],
    to: process.env['TO'],
    // STEP thins the decision grid. Handled by the engine rather than by a
    // wrapper here, so a skipped bar does not pay for its visible slice first.
    decideEvery: step,
    // Mirrors the live engine's benchmark, so relative-strength factors are
    // exercised in replay rather than silently abstaining.
    benchmarkSymbol: process.env['BENCHMARK'] ?? 'SPY',
  });
  process.stderr.write('\r');
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  const s = result.stats;
  console.log(`═══ ${result.strategy} — ${s.total} plans in ${elapsed}s ═══`);
  if (!includeNoTrade) {
    console.log(`  resolved      ${s.resolved}   (ambiguous ${s.ambiguous})`);
    console.log(`  win rate      ${pct(s.winRate)}`);
    console.log(`  expectancy    ${num(s.expectancyR)}R per resolved trade`);
    console.log(`  total         ${s.totalR.toFixed(1)}R`);
    console.log(`  max drawdown  ${s.maxDrawdownR.toFixed(1)}R`);
    // Same trades, weighted by the accuracy sizing signal, mean-normalised so
    // any gain comes from concentration rather than from betting bigger.
    const flatRatio = s.maxDrawdownR > 0 ? s.totalR / s.maxDrawdownR : 0;
    const sizedRatio = s.sizedMaxDrawdownR > 0 ? s.sizedTotalR / s.sizedMaxDrawdownR : 0;
    console.log(`\n  ── accuracy-weighted sizing (mean size ${s.meanSize.toFixed(2)}x, normalised) ──`);
    console.log(`  flat      ${s.totalR.toFixed(1).padStart(8)}R   maxDD ${s.maxDrawdownR.toFixed(1).padStart(6)}R   R/DD ${flatRatio.toFixed(2)}`);
    console.log(`  sized     ${s.sizedTotalR.toFixed(1).padStart(8)}R   maxDD ${s.sizedMaxDrawdownR.toFixed(1).padStart(6)}R   R/DD ${sizedRatio.toFixed(2)}`);
    const lift = flatRatio > 0 ? (sizedRatio / flatRatio - 1) * 100 : 0;
    console.log(`  sizing ${lift >= 0 ? 'improves' : 'WORSENS'} return-per-drawdown by ${Math.abs(lift).toFixed(1)}%`);
  }

  const z = result.zoneError;
  const key = runKey(symbols, step, includeNoTrade);
  const baselines = loadBaselines();
  const base = baselines[key];

  console.log(`\n═══ zone placement (median |zone - realised extreme|, ATR) ═══`);
  const line = (label: string, v: number | null, n: number, b: number | null | undefined) => {
    if (v === null) { console.log(`  ${label.padEnd(8)} n/a`); return; }
    if (b === null || b === undefined) { console.log(`  ${label.padEnd(8)} ${v.toFixed(2)}  (n=${n})`); return; }
    const delta = v - b;
    const mark = delta < -0.01 ? 'improved' : delta > 0.01 ? 'REGRESSED' : 'unchanged';
    console.log(`  ${label.padEnd(8)} ${v.toFixed(2)}  (n=${n}, baseline ${b.toFixed(2)}, ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} ${mark})`);
  };
  line('demand', z.demandMedianAtr, z.demandN, base?.demand);
  line('supply', z.supplyMedianAtr, z.supplyN, base?.supply);
  if (!base) {
    console.log(`  no baseline for this exact universe/period — record one with SAVE_BASELINE=1`);
  } else {
    console.log(`  baseline recorded ${base.recordedAt.slice(0, 10)} over ${base.plans} plans`);
  }

  if (process.env['SAVE_BASELINE'] === '1') {
    baselines[key] = {
      demand: z.demandMedianAtr, supply: z.supplyMedianAtr,
      recordedAt: new Date().toISOString(), plans: result.stats.total,
    };
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(baselines, null, 2));
    console.log(`  ✅ baseline saved for this run's parameters`);
  }

  // ── Does conviction predict? ────────────────────────────────────────────
  // The question the score has never been asked. Conviction drives ranking and
  // display; if outcome does not improve with it, it is decoration.
  const withConv = result.trades.filter(t => t.conviction !== null && t.realizedR !== null && t.outcome !== 'AMBIGUOUS');
  if (withConv.length >= 30 && !includeNoTrade) {
    const sorted = [...withConv].sort((a, b) => a.conviction! - b.conviction!);
    const bucketCount = 4;
    const size = Math.floor(sorted.length / bucketCount);
    console.log(`\n═══ does conviction predict? (${withConv.length} graded plans, equal-count buckets) ═══`);
    console.log('  conviction range      n     win%    expectancy');
    const points: Array<{ mid: number; exp: number }> = [];
    for (let b = 0; b < bucketCount; b++) {
      const slice = b === bucketCount - 1 ? sorted.slice(b * size) : sorted.slice(b * size, (b + 1) * size);
      if (!slice.length) continue;
      const lo = slice[0].conviction!, hi = slice[slice.length - 1].conviction!;
      const wins = slice.filter(t => t.outcome === 'TARGET').length;
      const exp = slice.reduce((sum, t) => sum + (t.realizedR ?? 0), 0) / slice.length;
      points.push({ mid: (lo + hi) / 2, exp });
      console.log(`  ${lo.toFixed(2)}–${hi.toFixed(2)}  ${String(slice.length).padStart(9)}  ${pct(wins / slice.length).padStart(6)}  ${exp.toFixed(3).padStart(10)}R`);
    }
    // Correlation between conviction and realised R across every trade.
    const xs = withConv.map(t => t.conviction!), ys = withConv.map(t => t.realizedR!);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num2 = 0, dx = 0, dy = 0;
    for (let i = 0; i < xs.length; i++) { num2 += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
    const r = dx > 0 && dy > 0 ? num2 / Math.sqrt(dx * dy) : 0;
    const monotone = points.every((p, i) => i === 0 || p.exp >= points[i - 1].exp - 0.02);
    console.log(`  correlation(conviction, realised R) = ${r.toFixed(3)}  ${Math.abs(r) < 0.05 ? '— effectively none' : ''}`);
    console.log(`  monotonic across buckets: ${monotone ? 'yes' : 'NO — higher conviction is not better'}`);
  }

  // ── Direction and era ───────────────────────────────────────────────────
  if (!includeNoTrade) {
    const graded = result.trades.filter(t => t.realizedR !== null && t.outcome !== 'AMBIGUOUS');
    const group = (label: string, keyOf: (t: typeof graded[number]) => string) => {
      const m: Record<string, { n: number; w: number; r: number }> = {};
      for (const t of graded) {
        const k = keyOf(t);
        m[k] ??= { n: 0, w: 0, r: 0 };
        m[k].n++; m[k].r += t.realizedR!;
        if (t.outcome === 'TARGET') m[k].w++;
      }
      console.log(`\n═══ by ${label} ═══`);
      for (const [k, v] of Object.entries(m).sort((a, b) => b[1].n - a[1].n)) {
        if (v.n < 5) continue;
        console.log(`  ${k.padEnd(14)} n=${String(v.n).padStart(5)}  win=${pct(v.w / v.n).padStart(6)}  exp=${(v.r / v.n).toFixed(3).padStart(7)}R  total=${v.r.toFixed(1).padStart(8)}R`);
      }
    };
    group('direction', t => t.bias);
    group('decade', t => `${t.asOf.slice(0, 3)}0s`);
  }

  const factors = Object.entries(result.factorStats)
    .filter(([, v]) => v.n >= 5)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 15);
  if (factors.length) {
    console.log(`\n═══ factor accuracy (directional, decayed) ═══`);
    for (const [name, v] of factors) {
      console.log(`  ${name.slice(0, 42).padEnd(42)} n=${v.n.toFixed(1).padStart(6)}  win=${pct(winRate(v))}`);
    }
  }

  const setups = Object.entries(result.setupStats)
    .filter(([, v]) => v.n >= 3)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 12);
  if (setups.length && !includeNoTrade) {
    console.log(`\n═══ setups ═══`);
    for (const [name, v] of setups) {
      console.log(`  ${name.slice(0, 36).padEnd(36)} n=${v.n.toFixed(1).padStart(6)}  win=${pct(winRate(v))}  exp=${num(expectancy(v))}R`);
    }
  }
  // Raw trades, for analysis the built-in summaries do not cover.
  const dump = process.env['DUMP'];
  if (dump) {
    fs.writeFileSync(dump, result.trades.map(t => JSON.stringify(t)).join('\n'));
    console.log(`\n  wrote ${result.trades.length} trades -> ${dump}`);
  }
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
