import 'dotenv/config';
/**
 * Audit the REGISTERED factors the way the lab audits candidates.
 *
 *   npm run factor-audit --workspace=backend
 *   FROM=2013-01-01 STEP=5 npm run factor-audit --workspace=backend
 *
 * WHY THIS EXISTS. The engine already scores each factor by directional
 * accuracy — did its bias match the sign of the 20-bar forward return — and
 * feeds that number to the learning loop and to position sizing. Measured
 * across 76 research candidates, that statistic has a correlation of 0.94 with
 * how often the indicator votes LONG, and essentially none with whether it is
 * right. Equities drift up, so a permanently bullish signal scores ~56% and a
 * permanently bearish one ~44%, both while knowing nothing.
 *
 * This script re-measures the production factors on the same footing the lab
 * uses, so the two can be compared:
 *
 *   acc       raw sign match — what the engine currently records
 *   accAdj    sign match against the cross-sectionally demeaned forward return
 *   edge      acc minus what a COIN with this factor's own long/short mix would
 *             have scored on the same bars. This is the number that answers
 *             "does this factor know anything", and it is the one the engine
 *             should have been learning from.
 *
 * A factor whose `acc` is far from 50% and whose `edge` is near zero is not
 * skilled or anti-skilled. It is one-sided, and its accuracy is a readout of
 * its own vote mix.
 */
import fs from 'node:fs';
import { cachedSymbols, readPanel, DEFAULT_CACHE_DIR } from '../services/backtest/barCache.js';
import { loadIntegrityReport, trustedFromMs } from '../services/backtest/barIntegrity.js';
import { buildPanelSet, forwardReturns, trimPanel, neweyWestSE } from '../services/quant/indicatorLab.js';
import { getFactors } from '../services/factors/factorRegistry.js';
import type { FactorInput } from '../services/factors/types.js';
import type { OHLCVDataPoint } from '../types.js';

const HORIZON = Number(process.env['HORIZON'] ?? 20);
/**
 * Bars of context handed to each factor.
 *
 * Production hands the factor stack a warmup of 126 bars; the longest lookback
 * any registered factor reaches for is well inside that. 260 is double the
 * warmup, which keeps every factor's own window intact while bounding the
 * per-decision allocation — the audit builds this array once per decision bar
 * across hundreds of thousands of them, and an unbounded slice of forty years
 * would dominate the run.
 */
const CONTEXT_BARS = Number(process.env['CONTEXT_BARS'] ?? 300);

/** Benchmark supplied to relative-strength factors, mirroring the live engine. */
const BENCHMARK = process.env['BENCHMARK'] ?? 'SPY';

interface Tally {
  /**
   * False when the factor declares `directional: false` — it emits levels or a
   * regime read but casts no vote the engine counts.
   *
   * Its bias is still tallied here, because the point of the audit is to keep
   * measuring a demoted factor: the demotion was a decision made ON this
   * number, and it has to stay visible so the decision can be revisited. But
   * the report must never let a non-voter's row read as though it still
   * influences a plan, and a non-voter must not enter the long-share
   * correlation, which is a claim about the LIVE scoring path.
   */
  votingInEngine: boolean;
  bullish: number; bearish: number; neutral: number;
  /** Hits split by the direction VOTED, which is what informedness needs. */
  bullHits: number; bearHits: number;
  hits: number; hitsAdj: number; scored: number;
  /** Per-date mean of (vote sign x demeaned forward return), for a t-stat. */
  daily: Map<number, { sum: number; n: number }>;
}

const pctf = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '  n/a');

async function main() {
  const integrity = loadIntegrityReport();
  if (!integrity) {
    console.log('\nNo bar-integrity.json. Run: npm run audit-bars --workspace=backend\n');
    return;
  }
  const requested = process.env['SYMS']?.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const names = requested ?? cachedSymbols(DEFAULT_CACHE_DIR, '1day');
  const panels = names
    .map(s => readPanel(DEFAULT_CACHE_DIR, s, '1day'))
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map(p => trimPanel(p, trustedFromMs(integrity, p.symbol)))
    .filter(p => p.n > CONTEXT_BARS + HORIZON + 10);

  /**
   * Benchmark bars, indexed by date so each decision gets a causal slice.
   *
   * Relative-strength factors abstain without it, and they are the only kind
   * that measured out of sample — auditing them against nothing would report a
   * silent factor as an absent one.
   */
  const benchPanel = readPanel(DEFAULT_CACHE_DIR, BENCHMARK, '1day');
  const benchByDate = new Map<number, number>();
  if (benchPanel) for (let i = 0; i < benchPanel.n; i++) benchByDate.set(benchPanel.t[i], i);

  const set = buildPanelSet(panels);
  const fwd = panels.map(p => forwardReturns(p, HORIZON));
  const step = Number(process.env['STEP'] ?? 5);
  const fromMs = process.env['FROM'] ? Date.parse(process.env['FROM']) : -Infinity;
  const toMs = process.env['TO'] ? Date.parse(process.env['TO']) : Infinity;

  const factors = getFactors();
  console.log(`\n${factors.length} registered factors over ${panels.length} symbols, every ${step}th bar, horizon ${HORIZON}`);
  console.log(`period ${process.env['FROM'] ?? 'all'} .. ${process.env['TO'] ?? 'now'}\n`);

  /**
   * The market's forward return on each date, for the drift adjustment.
   *
   * Built from the panel itself rather than from the benchmark: the adjustment
   * has to remove the average move of the names actually being voted on, and
   * SPY's move is not that whenever the universe is tilted.
   */
  const dateMean = new Map<number, { sum: number; n: number }>();
  for (let s = 0; s < panels.length; s++) {
    const p = panels[s];
    for (let i = 0; i < p.n; i++) {
      if (!Number.isFinite(fwd[s][i])) continue;
      const key = p.t[i];
      const e = dateMean.get(key) ?? { sum: 0, n: 0 };
      e.sum += fwd[s][i]; e.n++;
      dateMean.set(key, e);
    }
  }

  const tallies = new Map<string, Tally>();
  const tally = (name: string) => {
    let t = tallies.get(name);
    if (!t) { t = { votingInEngine: true, bullish: 0, bearish: 0, neutral: 0, bullHits: 0, bearHits: 0, hits: 0, hitsAdj: 0, scored: 0, daily: new Map() }; tallies.set(name, t); }
    return t;
  };

  let decisions = 0;
  const started = Date.now();
  for (let s = 0; s < panels.length; s++) {
    const p = panels[s];
    process.stderr.write(`\r  ${s + 1}/${panels.length}  ${p.symbol.padEnd(7)} ${decisions.toLocaleString()} decisions`);
    for (let i = CONTEXT_BARS; i + HORIZON < p.n; i += step) {
      if (p.t[i] < fromMs || p.t[i] > toMs) continue;
      const r = fwd[s][i];
      if (!Number.isFinite(r)) continue;
      const dm = dateMean.get(p.t[i]);
      // A date with too thin a cross-section cannot support a drift adjustment.
      if (!dm || dm.n < 20) continue;
      const demeaned = r - dm.sum / dm.n;

      const bars: OHLCVDataPoint[] = [];
      for (let k = i - CONTEXT_BARS + 1; k <= i; k++) {
        bars.push({
          datetime: new Date(p.t[k]).toISOString(),
          open: p.o[k], high: p.h[k], low: p.l[k], close: p.c[k], volume: p.v[k],
        } as OHLCVDataPoint);
      }
      /**
       * Benchmark prefix ending at the DECISION date, never past it. Located by
       * date rather than by index because the two series do not share a
       * calendar once listings and halts differ.
       */
      let benchmarkBars: OHLCVDataPoint[] | undefined;
      if (benchPanel) {
        const bi = benchByDate.get(p.t[i]);
        if (bi !== undefined && bi >= CONTEXT_BARS) {
          benchmarkBars = [];
          for (let k = bi - CONTEXT_BARS + 1; k <= bi; k++) {
            benchmarkBars.push({
              datetime: new Date(benchPanel.t[k]).toISOString(),
              open: benchPanel.o[k], high: benchPanel.h[k], low: benchPanel.l[k],
              close: benchPanel.c[k], volume: benchPanel.v[k],
            } as OHLCVDataPoint);
          }
        }
      }

      const input = {
        symbol: p.symbol, currentPrice: p.c[i], bars, benchmarkBars,
        intradayBars: undefined, optionsChain: undefined, activeExpiry: undefined,
        sentiment: undefined, news: undefined,
      } as FactorInput;

      decisions++;
      for (const f of factors) {
        let result;
        try { result = await f.evaluate(input); } catch { continue; }
        if (!result) continue;
        const t = tally(result.factorName);
        if (result.directional === false) t.votingInEngine = false;
        if (result.bias === 'neutral') { t.neutral++; continue; }
        const long = result.bias === 'bullish';
        long ? t.bullish++ : t.bearish++;
        t.scored++;
        if (long === r > 0) { t.hits++; long ? t.bullHits++ : t.bearHits++; }
        if (long === demeaned > 0) t.hitsAdj++;
        const e = t.daily.get(p.t[i]) ?? { sum: 0, n: 0 };
        e.sum += (long ? 1 : -1) * demeaned; e.n++;
        t.daily.set(p.t[i], e);
      }
    }
  }
  process.stderr.write('\r' + ' '.repeat(70) + '\r');
  console.log(`${decisions.toLocaleString()} decision bars in ${((Date.now() - started) / 1000).toFixed(0)}s\n`);

  /**
   * Base rate: what a coin with this factor's own long/short mix would score.
   *
   * `up` is the share of scored bars whose forward return was positive, so a
   * factor that votes long a fraction L of the time expects
   * L*up + (1-L)*(1-up) by chance alone. Subtracting it strips out exactly the
   * drift component that the raw accuracy is otherwise dominated by.
   */
  let upBars = 0, allBars = 0;
  for (let s = 0; s < panels.length; s++) {
    const p = panels[s];
    for (let i = CONTEXT_BARS; i + HORIZON < p.n; i += step) {
      if (p.t[i] < fromMs || p.t[i] > toMs) continue;
      const r = fwd[s][i];
      if (!Number.isFinite(r)) continue;
      allBars++; if (r > 0) upBars++;
    }
  }
  const up = allBars ? upBars / allBars : 0.5;
  console.log(`base rate: ${pctf(up)} of ${allBars.toLocaleString()} sampled bars were higher ${HORIZON} bars later\n`);

  const rows = [...tallies.entries()].map(([name, t]) => {
    const votes = t.bullish + t.bearish;
    const longShare = votes ? t.bullish / votes : NaN;
    const acc = votes ? t.hits / votes : NaN;
    const accAdj = votes ? t.hitsAdj / votes : NaN;
    const chance = longShare * up + (1 - longShare) * (1 - up);
    /**
     * Informedness (Youden's J): P(up | voted bullish) - P(up | voted bearish).
     *
     * The base-rate-free way to ask whether a factor discriminates. Raw accuracy
     * mixes skill with drift because it is `L*bullAcc + (1-L)*bearAcc`, and the
     * mix term dominates whenever L is far from a half. J subtracts one
     * conditional rate from the other, so any drift common to both cancels: a
     * factor with no information scores 0 whatever the market did and whatever
     * its own long/short mix is.
     *
     * Reported halved, so it sits on the same +/-0.5 scale as the
     * `accuracy - 0.5` term it is meant to replace and the existing sizing gain
     * stays calibrated.
     */
    const bullAcc = t.bullish ? t.bullHits / t.bullish : NaN;
    const bearAcc = t.bearish ? t.bearHits / t.bearish : NaN;
    const informedness = (bullAcc + bearAcc - 1) / 2;
    // Standard error of a difference of two independent proportions.
    const seJ = Math.sqrt(
      (bullAcc * (1 - bullAcc)) / Math.max(1, t.bullish) + (bearAcc * (1 - bearAcc)) / Math.max(1, t.bearish),
    ) / 2;
    const series = [...t.daily.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.sum / v.n);
    const mean = series.length ? series.reduce((a, b) => a + b, 0) / series.length : NaN;
    const se = neweyWestSE(series, HORIZON);
    return {
      name, votes, neutral: t.neutral, longShare, acc, accAdj, voting: t.votingInEngine,
      edge: acc - chance, tStat: se > 0 ? mean / se : NaN, dates: series.length,
      bullAcc, bearAcc, informedness,
      /**
       * The J t-statistic assumes independent votes and this sample overlaps —
       * consecutive decision bars share up to 19 of 20 forward days — so it is
       * inflated by roughly sqrt(horizon/step). It is reported as an upper
       * bound on significance, which is all it is needed for: the finding here
       * is that nothing clears even the generous bar.
       */
      jT: seJ > 0 ? informedness / seJ : NaN,
    };
  }).sort((a, b) => (Math.abs(b.informedness) || 0) - (Math.abs(a.informedness) || 0));

  console.log('factor                                     votes   long%     acc  bullAcc bearAcc     J     t(J)*   edge');
  for (const r of rows) {
    // A demoted factor is still measured, but marked, so no row reads as an
    // influence on live plans when it no longer is one.
    const mark = r.voting ? '  ' : '· ';
    console.log(
      `${mark}${r.name.slice(0, 40).padEnd(40)} ${String(r.votes).padStart(7)} ` +
      `${pctf(r.longShare).padStart(7)} ${pctf(r.acc).padStart(7)} ${pctf(r.bullAcc).padStart(7)} ${pctf(r.bearAcc).padStart(7)} ` +
      `${(Number.isFinite(r.informedness) ? (r.informedness * 100).toFixed(1) : 'n/a').padStart(6)}pp ` +
      `${(Number.isFinite(r.jT) ? r.jT.toFixed(1) : 'n/a').padStart(6)} ${(r.edge * 100).toFixed(1).padStart(5)}pp`,
    );
  }
  console.log('  * t(J) ignores the overlap between consecutive decision bars, so it is an UPPER bound.');

  // The headline test, run over the factors themselves rather than asserted.
  const nonVoting = rows.filter(r => !r.voting);
  if (nonVoting.length) {
    console.log(`  · = declares directional:false — levels or regime only, no vote counted ` +
      `(${nonVoting.map(r => r.name.split(' ')[0]).join(', ')})`);
  }
  // The correlation is a claim about the live scoring path, so it is computed
  // over VOTING factors only.
  const withVotes = rows.filter(r => r.voting && r.votes > 500 && Number.isFinite(r.longShare));
  const corr = (xs: number[], ys: number[]) => {
    const n = xs.length; if (n < 3) return NaN;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
    return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
  };
  const ls = withVotes.map(r => r.longShare);
  console.log(`\n  correlation(long-share, raw accuracy)   = ${corr(ls, withVotes.map(r => r.acc)).toFixed(3)}   over ${withVotes.length} factors`);
  console.log(`  correlation(long-share, edge)           = ${corr(ls, withVotes.map(r => r.edge)).toFixed(3)}`);
  console.log('  A raw accuracy that tracks long-share is measuring the vote mix, not the factor.\n');

  const dump = process.env['DUMP'];
  if (dump) { fs.writeFileSync(dump, JSON.stringify({ up, horizon: HORIZON, step, rows }, null, 2)); console.log(`  wrote ${dump}\n`); }
}

main().catch(e => { console.error(e); process.exit(1); });
