import 'dotenv/config';
/**
 * Does the engine's outcome depend on the MACRO STATE at entry?
 *
 *   DUMP=trades.ndjson npm run macro-audit --workspace=backend
 *
 * Answered by joining a replay's trade dump to market-wide state series, rather
 * than by building new machinery first. If no state separates outcomes on
 * 13,000 trades already on disk, there is nothing to build.
 *
 * WHY A JOIN AND NOT A NEW LAB. The indicator lab measures cross-sectional
 * skill and is blind to market-wide signals on purpose. Rather than duplicate
 * it for the time-series case, this asks the question that actually matters:
 * conditional on the macro state the day a plan fired, did that plan do better
 * or worse? That is directly the "should the engine trade here at all" question,
 * measured on the engine's own trades.
 *
 * STANDARD OF PROOF. Terciles rather than a fitted threshold; LONG and SHORT
 * reported separately because they are established to behave differently; a
 * two-sample t on expectancy between the extreme terciles; and the split
 * repeated on holdout symbols and on the modern era, since this project has
 * retracted three findings that lived only in one cell.
 */
import fs from 'node:fs';
import { cachedSymbols, readPanel, DEFAULT_CACHE_DIR } from '../services/backtest/barCache.js';
import { loadIntegrityReport, trustedFromMs } from '../services/backtest/barIntegrity.js';
import { buildPanelSet, trimPanel } from '../services/quant/indicatorLab.js';
import { alignClose, buildMacroStates } from '../services/quant/macroState.js';

interface Trade {
  symbol: string; asOf: string; bias: 'LONG' | 'SHORT';
  outcome: string; realizedR: number | null;
}

function isDiscoverySymbol(symbol: string): boolean {
  let h = 2166136261;
  for (let i = 0; i < symbol.length; i++) { h ^= symbol.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10) < 6;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

async function main() {
  const dumpPath = process.env['DUMP'];
  if (!dumpPath || !fs.existsSync(dumpPath)) {
    console.log('\nSet DUMP to a replay trade dump, e.g.\n  LOCAL=1 STEP=10 DUMP=trades.ndjson npm run backtest --workspace=backend\n');
    return;
  }
  const trades: Trade[] = fs.readFileSync(dumpPath, 'utf-8').split('\n').filter(Boolean)
    .map(l => JSON.parse(l))
    .filter(t => t.outcome !== 'AMBIGUOUS' && t.realizedR !== null);

  const integrity = loadIntegrityReport();
  const panels = cachedSymbols(DEFAULT_CACHE_DIR, '1day')
    .map(s => readPanel(DEFAULT_CACHE_DIR, s, '1day'))
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map(p => trimPanel(p, trustedFromMs(integrity, p.symbol)))
    .filter(p => p.n > 100);
  const set = buildPanelSet(panels);

  const closes = new Map<string, Float64Array>();
  panels.forEach((p, i) => closes.set(p.symbol, alignClose(p, set.dateIndex[i], set.dates.length)));
  const states = buildMacroStates({ dates: set.dates, closes });

  // Date -> index, so each trade can look up the state on its entry day.
  const dateIdx = new Map<number, number>();
  set.dates.forEach((d, i) => dateIdx.set(d, i));
  const stateAt = (s: (typeof states)[number], asOf: string): number => {
    const key = Date.parse(asOf.slice(0, 10) + 'T00:00:00.000Z');
    let i = dateIdx.get(key);
    if (i === undefined) {
      // The trade's own bar timestamp may carry a time; fall back to a scan.
      const t = Date.parse(asOf);
      i = dateIdx.get(t);
    }
    return i === undefined ? NaN : s.values[i];
  };

  console.log(`\n${trades.length.toLocaleString()} graded trades, ${states.length} macro states\n`);
  /**
   * The bar every row below has to clear.
   *
   * Three books per state is 3N comparisons, and the expected largest |t| among
   * N independent draws under the null is about sqrt(2 ln N). Reading any single
   * row against 2.0 is how a search of this size manufactures a finding — the
   * same failure the indicator search calibrates away with a shuffled control.
   */
  const comparisons = states.length * 3;
  const noiseBar = Math.sqrt(2 * Math.log(comparisons));
  console.log(`${comparisons} comparisons — the largest |t| expected from pure noise is ~${noiseBar.toFixed(2)}.`);
  console.log(`Treat that, not 2.0, as the threshold.\n`);

  const cells: Array<[string, (t: Trade) => boolean]> = [
    ['ALL', () => true],
    ['HOLDOUT symbols', t => !isDiscoverySymbol(t.symbol)],
    ['modern 2013+', t => t.asOf >= '2013'],
  ];

  for (const state of states) {
    const withState = trades
      .map(t => ({ t, s: stateAt(state, t.asOf) }))
      .filter(x => Number.isFinite(x.s));
    if (withState.length < 1000) {
      console.log(`── ${state.name}: only ${withState.length} trades have this state — skipped\n`);
      continue;
    }
    const sorted = [...withState].sort((a, b) => a.s - b.s);
    const cut = Math.floor(sorted.length / 3);
    const lo = sorted.slice(0, cut), hi = sorted.slice(-cut);

    console.log(`══ ${state.name} — ${state.description}`);
    console.log(`   ${'book'.padEnd(8)}${'low tercile'.padStart(26)}${'high tercile'.padStart(26)}${'diff'.padStart(10)}${'t'.padStart(7)}`);
    for (const book of ['ALL', 'LONG', 'SHORT'] as const) {
      const sel = (xs: typeof sorted) => xs.filter(x => book === 'ALL' || x.t.bias === book).map(x => x.t.realizedR!);
      const a = sel(lo), b = sel(hi);
      if (a.length < 150 || b.length < 150) continue;
      const d = mean(b) - mean(a);
      const se = Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length);
      const winA = sel(lo).length ? lo.filter(x => (book === 'ALL' || x.t.bias === book) && x.t.outcome === 'TARGET').length / a.length : 0;
      const winB = hi.filter(x => (book === 'ALL' || x.t.bias === book) && x.t.outcome === 'TARGET').length / b.length;
      const cellA = `n=${a.length} ${(winA * 100).toFixed(1)}% ${mean(a) >= 0 ? '+' : ''}${mean(a).toFixed(4)}R`;
      const cellB = `n=${b.length} ${(winB * 100).toFixed(1)}% ${mean(b) >= 0 ? '+' : ''}${mean(b).toFixed(4)}R`;
      const diff = `${d >= 0 ? '+' : ''}${d.toFixed(4)}R`;
      console.log(`   ${book.padEnd(8)}${cellA.padStart(26)}${cellB.padStart(26)}${diff.padStart(10)}${(d / se).toFixed(2).padStart(7)}`);
    }
    /**
     * Split further only when SOME book looked like anything.
     *
     * Gating on the pooled ALL book was wrong: LONG and SHORT are established
     * to behave differently here, so a real direction-specific effect cancels
     * against its opposite and never reaches the out-of-sample check. Credit
     * stress showed t = -2.69 on LONG and -1.09 pooled.
     */
    const bookT = (sel: (x: { t: Trade }) => boolean) => {
      const a = lo.filter(sel).map(x => x.t.realizedR!);
      const b = hi.filter(sel).map(x => x.t.realizedR!);
      if (a.length < 150 || b.length < 150) return 0;
      return (mean(b) - mean(a)) / Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length);
    };
    const strongest = Math.max(
      Math.abs(bookT(() => true)),
      Math.abs(bookT(x => x.t.bias === 'LONG')),
      Math.abs(bookT(x => x.t.bias === 'SHORT')),
    );
    if (strongest >= 2) {
      // Reported on the LONG book, where every effect worth a second look sat.
      for (const [label, f] of cells.slice(1)) {
        const a = lo.filter(x => f(x.t) && x.t.bias === 'LONG').map(x => x.t.realizedR!);
        const b = hi.filter(x => f(x.t) && x.t.bias === 'LONG').map(x => x.t.realizedR!);
        if (a.length < 120 || b.length < 120) continue;
        const d = mean(b) - mean(a);
        const se = Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length);
        const ca = `n=${a.length} ${mean(a) >= 0 ? '+' : ''}${mean(a).toFixed(4)}R`;
        const cb = `n=${b.length} ${mean(b) >= 0 ? '+' : ''}${mean(b).toFixed(4)}R`;
        const dd = `${d >= 0 ? '+' : ''}${d.toFixed(4)}R`;
        console.log(`   ${('· ' + label).padEnd(8)}${ca.padStart(26)}${cb.padStart(26)}${dd.padStart(10)}${(d / se).toFixed(2).padStart(7)}`);
      }
    }
    console.log('');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
