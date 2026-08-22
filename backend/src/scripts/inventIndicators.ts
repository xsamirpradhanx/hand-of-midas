import 'dotenv/config';
/**
 * Search the indicator grammar for something that forecasts, and report it
 * against the bar the same search clears on noise.
 *
 *   npm run invent-indicators --workspace=backend
 *   POP=60 GENS=12 SEED=7 npm run invent-indicators --workspace=backend
 *
 * THE PROTOCOL, and the reason for each step:
 *
 *   1. SEARCH on discovery symbols in the middle era only. Holdout symbols and
 *      the recent era are never evaluated during the search, so they stay
 *      genuinely unseen rather than "unseen except by the selection step".
 *   2. NULL RUN — the identical search, same seed, same budget, against forward
 *      returns shuffled within each date. Its best fitness is what this search
 *      architecture extracts from noise on data of this shape.
 *   3. Survivors are whatever beats the null's best, and only those are then
 *      scored on the untouched cells.
 *
 * Step 2 is the point. Skipping it turns any generative search into a machine
 * for producing t-statistics of 4, because the expected maximum of N draws under
 * the null grows like sqrt(2 ln N) and the search optimises directly for it.
 */
import fs from 'node:fs';
import { cachedSymbols, readPanel, DEFAULT_CACHE_DIR } from '../services/backtest/barCache.js';
import { loadIntegrityReport, trustedFromMs } from '../services/backtest/barIntegrity.js';
import {
  buildPanelSet, forwardReturns, scoreCandidate, assertCausal, trimPanel, DEFAULT_HORIZON,
  type IndicatorScore,
} from '../services/quant/indicatorLab.js';
import { Rng, render, toCandidate } from '../services/quant/indicatorGrammar.js';
import { search, shuffleForwardWithinDates } from '../services/quant/indicatorSearch.js';

const ERA1 = process.env['ERA1'] ?? '2013-01-01';
const ERA2 = process.env['ERA2'] ?? '2021-01-01';
const HORIZON = Number(process.env['HORIZON'] ?? DEFAULT_HORIZON);
const POP = Number(process.env['POP'] ?? 50);
const GENS = Number(process.env['GENS'] ?? 10);
const SEED = Number(process.env['SEED'] ?? 20260822);

function isDiscoverySymbol(symbol: string): boolean {
  let h = 2166136261;
  for (let i = 0; i < symbol.length; i++) { h ^= symbol.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10) < 6;
}

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '  n/a');
const f = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');

async function main() {
  const integrity = loadIntegrityReport();
  if (!integrity) { console.log('\nRun: npm run audit-bars --workspace=backend\n'); return; }

  const symbols = cachedSymbols(DEFAULT_CACHE_DIR, '1day');
  const panels = symbols
    .map(s => readPanel(DEFAULT_CACHE_DIR, s, '1day'))
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map(p => trimPanel(p, trustedFromMs(integrity, p.symbol)))
    .filter(p => p.n > 400);
  const set = buildPanelSet(panels);
  const fwd = panels.map(p => forwardReturns(p, HORIZON));

  const kept = panels.map(p => p.symbol);
  const disc = new Set(kept.filter(isDiscoverySymbol));
  const hold = new Set(kept.filter(s => !isDiscoverySymbol(s)));

  console.log(`\n${panels.length} symbols   horizon ${HORIZON}   population ${POP} x ${GENS} generations   seed ${SEED}`);
  console.log(`search cell: ${disc.size} discovery symbols, ${ERA1}..${ERA2}`);
  console.log(`untouched:   ${hold.size} holdout symbols, and everything from ${ERA2}\n`);

  /**
   * How many symbol-bars the search cell actually offers, so coverage is a
   * fraction rather than a magic number. Counted the way scoreCandidate counts:
   * a finite forward return, inside the cell's symbols and dates.
   */
  const cellFrom = Date.parse(ERA1), cellTo = Date.parse(ERA2);
  let referenceN = 0;
  for (let s = 0; s < panels.length; s++) {
    if (!disc.has(panels[s].symbol)) continue;
    for (let i = 0; i < panels[s].n; i++) {
      const tms = panels[s].t[i];
      if (tms >= cellFrom && tms <= cellTo && Number.isFinite(fwd[s][i])) referenceN++;
    }
  }
  const minObservations = Math.floor(referenceN * 0.6);
  console.log(`cell offers ${referenceN.toLocaleString()} symbol-bars; candidates must cover ` +
    `${minObservations.toLocaleString()} (60%)\n`);

  const opts = {
    horizon: HORIZON, trainSymbols: disc, from: ERA1, to: ERA2,
    population: POP, generations: GENS, seed: SEED,
    maxBetaLoading: 0.35, minCrossSectionalShare: 0.5, minObservations,
    maxDepth: 4, minDates: 400,
  };

  const started = Date.now();
  console.log('── real data ──');
  const real = search(set, fwd, {
    ...opts,
    onProgress: (g, best, n) => process.stderr.write(
      `\r  gen ${g + 1}/${GENS}  best |t| ${best ? best.fitness.toFixed(2) : '—'}  ${n} evaluated   `),
  });
  process.stderr.write('\r' + ' '.repeat(70) + '\r');
  console.log(`  ${real.evaluated} expressions evaluated, best fitness ${real.best[0]?.fitness.toFixed(2) ?? 'n/a'}`);

  console.log('\n── null: identical search, forward returns shuffled within each date ──');
  const shuffled = shuffleForwardWithinDates(set, fwd, new Rng(SEED ^ 0x5eed));
  const nullRun = search(set, shuffled, {
    ...opts,
    onProgress: (g, best, n) => process.stderr.write(
      `\r  gen ${g + 1}/${GENS}  best |t| ${best ? best.fitness.toFixed(2) : '—'}  ${n} evaluated   `),
  });
  process.stderr.write('\r' + ' '.repeat(70) + '\r');
  const bar = nullRun.best[0]?.fitness ?? 0;
  console.log(`  ${nullRun.evaluated} expressions evaluated, best fitness ${bar.toFixed(2)}`);
  console.log(`  -> a search of this size extracts |t| = ${bar.toFixed(2)} from PURE NOISE. That is the bar.`);
  console.log(`\nsearched in ${((Date.now() - started) / 1000).toFixed(0)}s\n`);

  const nullTop = nullRun.best.slice(0, 5).map(s => s.fitness);
  const realTop = real.best.slice(0, 5).map(s => s.fitness);
  console.log(`  top-5 fitness   real ${realTop.map(x => x.toFixed(2)).join(', ')}`);
  console.log(`                  null ${nullTop.map(x => x.toFixed(2)).join(', ')}`);

  const survivors = real.best.filter(s => s.fitness > bar);
  console.log(`\n═══ ${survivors.length} of ${real.best.length} hall-of-fame expressions beat the noise bar ═══`);
  if (survivors.length === 0) {
    console.log('  Nothing here. The search found only what a search of this size finds in noise.\n');
  }

  const cells = [
    { label: 'SEARCH  disc/mid', symbols: disc, from: ERA1, to: ERA2 },
    { label: 'hold/mid', symbols: hold, from: ERA1, to: ERA2 },
    { label: 'disc/recent', symbols: disc, from: ERA2 },
    { label: 'HOLDOUT/recent', symbols: hold, from: ERA2 },
  ];

  const report: any[] = [];
  for (const s of survivors.slice(0, 8)) {
    const cand = toCandidate(s.expr, s.text);
    // Causality is re-checked on the finished expression: the grammar cannot
    // express a forward reference, but a bug in one operator would be silent.
    try {
      const probe = set.panels.find(p => p.symbol === 'AAPL') ?? set.panels[0];
      const pi = set.panels.indexOf(probe);
      assertCausal(cand, probe, {
        dates: set.dates, benchClose: set.benchClose, benchRet: set.benchRet,
        vixClose: set.vixClose, dateIndexOf: set.dateIndex[pi],
      });
    } catch (e: any) { console.log(`\n  ${s.text}\n    REJECTED: ${e.message}`); continue; }

    console.log(`\n  ${s.text}`);
    console.log(`    search fitness |t| ${s.fitness.toFixed(2)}  (re-scored below on the full panel; a large`);
    console.log(`    gap on the SEARCH row would mean the two evaluations disagree)`);
    console.log(`    ${'cell'.padEnd(18)}${'n'.padStart(8)}${'IC'.padStart(9)}${'t'.padStart(7)}${'accAdj'.padStart(9)}${'spread'.padStart(9)}${'beta'.padStart(7)}${'xs%'.padStart(7)}`);
    const row: any = { expr: s.text, cells: {} };
    for (const c of cells) {
      const sc: IndicatorScore = scoreCandidate(cand, set, fwd, {
        horizon: HORIZON, symbols: c.symbols, from: c.from, to: c.to,
        minCrossSection: 20, activeFraction: 1,
      });
      row.cells[c.label] = { ic: sc.ic, t: sc.icT, accAdj: sc.accAdj, spreadBp: sc.spreadBp, beta: sc.betaLoading, xs: sc.crossSectionalShare, n: sc.n };
      console.log(`    ${c.label.padEnd(18)}${sc.n.toLocaleString().padStart(8)}${f(sc.ic, 4).padStart(9)}${f(sc.icT, 1).padStart(7)}` +
        `${pct(sc.accAdj).padStart(9)}${f(sc.spreadBp, 0).padStart(9)}${f(sc.betaLoading, 2).padStart(7)}` +
        `${f(sc.crossSectionalShare, 2).padStart(7)}`);
    }
    report.push(row);
  }

  /**
   * The verdict, stated rather than left to be read off the table.
   *
   * Beating the noise bar means the search found something the same search does
   * NOT find in shuffled data. It does not mean the thing generalises, and the
   * two get conflated constantly. A candidate is only interesting if it keeps
   * its SIGN with usable significance on symbols the search never saw, in the
   * era closest to the one it would trade in.
   */
  const held = report.filter(r => {
    const a = r.cells['SEARCH  disc/mid'], b = r.cells['HOLDOUT/recent'];
    return Math.abs(b.t) >= 2 && (a.ic > 0) === (b.ic > 0);
  });
  console.log(`\n═══ verdict ═══`);
  console.log(`  ${survivors.length} beat the noise bar on the search cell`);
  console.log(`  ${held.length} keep their sign with |t| >= 2 on HOLDOUT symbols in the recent era`);
  if (held.length === 0) {
    console.log(`\n  Nothing to promote. Beating the noise bar shows the search found`);
    console.log(`  structure the shuffled control lacks; surviving the holdout cell is`);
    console.log(`  what would make it tradeable, and none of these does.`);
  } else {
    for (const r of held) console.log(`    ${r.expr}`);
  }

  const dump = process.env['DUMP'];
  if (dump) {
    fs.writeFileSync(dump, JSON.stringify({
      seed: SEED, population: POP, generations: GENS, horizon: HORIZON,
      era1: ERA1, era2: ERA2, noiseBar: bar,
      realEvaluated: real.evaluated, nullEvaluated: nullRun.evaluated,
      survivors: report,
      heldOutOfSample: report.filter(r => {
        const a = r.cells['SEARCH  disc/mid'], b = r.cells['HOLDOUT/recent'];
        return Math.abs(b.t) >= 2 && (a.ic > 0) === (b.ic > 0);
      }).map(r => r.expr),
      nullTop: nullRun.best.slice(0, 10).map(s => ({ expr: s.text, fitness: s.fitness })),
    }, null, 2));
    console.log(`\n  wrote ${dump}`);
  }
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
