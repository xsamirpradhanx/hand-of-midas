import 'dotenv/config';
/**
 * Search the candidate pool for indicators that actually forecast, and report
 * each survivor across a 2x2 out-of-sample design.
 *
 *   npm run indicator-lab --workspace=backend
 *   MIN_T=3 npm run indicator-lab --workspace=backend
 *   ONLY=mom_252_21,resmom_126_21 npm run indicator-lab --workspace=backend
 *   DUMP=lab.json npm run indicator-lab --workspace=backend
 *
 * THE DESIGN. Symbols are split by a deterministic hash into DISCOVERY (~60%)
 * and HOLDOUT (~40%); time is split at SPLIT_DATE. Candidates are ranked on
 * discovery symbols x early era only. Every survivor is then reported on all
 * four cells:
 *
 *              early era        late era
 *   disc       IN-SAMPLE        new regime, same names
 *   hold       new names        NEITHER — the honest number
 *
 * The point of separating the two axes is diagnostic. A candidate that holds on
 * new names but dies in the late era met a regime change; one that dies on new
 * names in the same era was fitted to the discovery symbols. Those are
 * different failures and they call for different responses, and a single
 * pooled out-of-sample number cannot tell them apart. Three of this project's
 * retracted findings were single-number out-of-sample checks.
 */
import fs from 'node:fs';
import { cachedSymbols, readPanel, DEFAULT_CACHE_DIR } from '../services/backtest/barCache.js';
import { loadIntegrityReport, trustedFromMs } from '../services/backtest/barIntegrity.js';
import {
  buildPanelSet, forwardReturns, scoreCandidate, assertCausal, trimPanel, DEFAULT_HORIZON,
  type IndicatorScore, type LabPanelSet,
} from '../services/quant/indicatorLab.js';
import { candidatePool } from '../services/quant/candidateIndicators.js';

/**
 * Three eras, not two.
 *
 * The first version of this split once, at 2013, and ranked candidates on
 * everything before it. That produced a clean but useless answer: eleven
 * candidates with t between 3.5 and 7.4 that replicated exactly on held-out
 * symbols and were all dead after 2013. Ranking on history a live system will
 * never see again selects for whatever used to work.
 *
 * So DISCOVERY is the MIDDLE era and the RECENT era is held back as the
 * out-of-sample test, with the early era demoted to a robustness note. A
 * candidate is only interesting if it survives `hold/recent` — held-out symbols
 * in the era closest to the one it will actually trade in.
 */
const ERA1 = process.env['ERA1'] ?? '2013-01-01';
const ERA2 = process.env['ERA2'] ?? '2021-01-01';
const HORIZON = Number(process.env['HORIZON'] ?? DEFAULT_HORIZON);

/**
 * Deterministic symbol split.
 *
 * Hashed rather than alphabetical or random: alphabetical correlates with
 * listing era and sector for some ranges, and an unseeded random split cannot
 * be reproduced when a result needs re-checking six months later.
 */
function isDiscoverySymbol(symbol: string): boolean {
  let h = 2166136261;
  for (let i = 0; i < symbol.length; i++) { h ^= symbol.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10) < 6;
}

const pctf = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '  n/a');
const f = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');

interface Cell { label: string; symbols: ReadonlySet<string>; from?: string; to?: string }

function report(rows: { score: IndicatorScore; cell: string }[]) {
  return rows;
}

async function main() {
  const symbols = cachedSymbols(DEFAULT_CACHE_DIR, '1day');
  if (symbols.length === 0) {
    console.log('\nNo local bar cache. Run: npm run export-bars --workspace=backend\n');
    return;
  }

  /**
   * The integrity quarantine is applied BEFORE anything is measured.
   *
   * A quarter of this store's Schwab history was dividend-adjusted by
   * subtraction, which drives old prices of long-time payers toward and past
   * zero and makes the returns computed across them arbitrarily large. Without
   * the trim, a handful of symbols supplies the extreme tail of every
   * cross-section they appear in and the whole panel's statistics are a readout
   * of them. Run `npm run audit-bars` to produce the report.
   */
  const integrity = loadIntegrityReport();
  if (!integrity) {
    console.log('\nNo bar-integrity.json. Run: npm run audit-bars --workspace=backend\n');
    return;
  }

  process.stderr.write('loading panels… ');
  const raw = symbols.map(s => readPanel(DEFAULT_CACHE_DIR, s, '1day')!).filter(Boolean);
  let quarantined = 0;
  const panels = raw
    .map(p => {
      const trimmed = trimPanel(p, trustedFromMs(integrity, p.symbol));
      quarantined += p.n - trimmed.n;
      return trimmed;
    })
    .filter(p => p.n > 300);
  const set: LabPanelSet = buildPanelSet(panels);
  const fwd = panels.map(p => forwardReturns(p, HORIZON));
  process.stderr.write(`${panels.length} symbols, ${panels.reduce((a, p) => a + p.n, 0).toLocaleString()} bars ` +
    `(${quarantined.toLocaleString()} quarantined by the integrity audit)\n`);

  const kept = panels.map(p => p.symbol);
  const disc = new Set(kept.filter(isDiscoverySymbol));
  const hold = new Set(kept.filter(s => !isDiscoverySymbol(s)));
  const all = new Set(kept);

  const cells: Cell[] = [
    { label: 'disc/mid', symbols: disc, from: ERA1, to: ERA2 },   // <- DISCOVERY
    { label: 'hold/mid', symbols: hold, from: ERA1, to: ERA2 },
    { label: 'disc/recent', symbols: disc, from: ERA2 },
    { label: 'hold/recent', symbols: hold, from: ERA2 },          // <- the honest number
    { label: 'disc/early', symbols: disc, to: ERA1 },
    { label: 'hold/early', symbols: hold, to: ERA1 },
    { label: 'ALL', symbols: all },
  ];
  const DISCOVERY = 'disc/mid';
  const OOS = 'hold/recent';

  const only = process.env['ONLY']?.split(',').map(s => s.trim()).filter(Boolean);
  let pool = candidatePool();
  if (only) pool = pool.filter(c => only.includes(c.name));

  // Look-ahead check before any candidate is scored. A leaking candidate would
  // otherwise top the table and the leak would be indistinguishable from skill.
  const probe = panels.find(p => p.symbol === 'AAPL') ?? panels[0];
  const probeIdx = panels.indexOf(probe);
  const probeMarket = {
    dates: set.dates, benchClose: set.benchClose, benchRet: set.benchRet, vixClose: set.vixClose,
    dateIndexOf: set.dateIndex[probeIdx],
  };
  for (const c of pool) assertCausal(c, probe, probeMarket);
  console.log(`causality check passed for ${pool.length} candidates\n`);

  console.log(`horizon ${HORIZON} bars   eras: early <${ERA1} | mid ${ERA1}..${ERA2} | recent ${ERA2}+`);
  console.log(`discovery ${disc.size} symbols / holdout ${hold.size}`);
  console.log(`ranking on ${DISCOVERY}; ${OOS} is the out-of-sample verdict\n`);

  const activeFraction = Number(process.env['ACTIVE'] ?? 0.3);
  const started = Date.now();
  const results: Record<string, Record<string, IndicatorScore>> = {};
  for (let ci = 0; ci < pool.length; ci++) {
    const c = pool[ci];
    process.stderr.write(`\r  scoring ${ci + 1}/${pool.length}  ${c.name.padEnd(20)}`);
    results[c.name] = {};
    for (const cell of cells) {
      results[c.name][cell.label] = scoreCandidate(c, set, fwd, {
        horizon: HORIZON, symbols: cell.symbols, from: cell.from, to: cell.to,
        activeFraction, minCrossSection: 20,
      });
    }
  }
  process.stderr.write('\r' + ' '.repeat(60) + '\r');
  console.log(`scored in ${((Date.now() - started) / 1000).toFixed(1)}s   (|signal| top ${(activeFraction * 100).toFixed(0)}% of each date's cross-section is scored)\n`);

  const ranked = pool
    .map(c => ({ name: c.name, family: c.family, s: results[c.name] }))
    .sort((a, b) => Math.abs(b.s[DISCOVERY].icT) - Math.abs(a.s[DISCOVERY].icT));

  const head = 'indicator            family                    IC      t     acc   accAdj  long%   spread(bp)   t    beta';
  const line = (name: string, family: string, s: IndicatorScore) =>
    `  ${name.padEnd(20)} ${family.slice(0, 24).padEnd(24)} ${f(s.ic, 4).padStart(7)} ${f(s.icT, 1).padStart(6)} ` +
    `${pctf(s.acc).padStart(7)} ${pctf(s.accAdj).padStart(7)} ${pctf(s.longShare).padStart(6)} ${f(s.spreadBp, 0).padStart(9)} ${f(s.spreadT, 1).padStart(6)} ${f(s.betaLoading, 2).padStart(6)}`;

  console.log(`═══ DISCOVERY (${DISCOVERY}) — ranked by |t(IC)| ═══`);
  console.log(head);
  for (const r of ranked) console.log(line(r.name, r.family, r.s[DISCOVERY]));

  // Whether the discovery edge SURVIVES, reported next to whether it existed.
  // A candidate keeping its sign and its significance out of sample is the only
  // result this lab is looking for; everything else is a decayed effect.
  console.log(`\n═══ out-of-sample (${OOS}) — same candidates, same order ═══`);
  console.log(head);
  for (const r of ranked) console.log(line(r.name, r.family, r.s[OOS]));

  const holds = (r: typeof ranked[number]) => {
    const d = r.s[DISCOVERY], o = r.s[OOS];
    return Math.sign(d.ic) === Math.sign(o.ic) && Math.abs(o.icT) >= 2;
  };
  const surviving = ranked.filter(holds);
  console.log(`\n  ${surviving.length} of ${ranked.length} candidates keep their sign with |t| >= 2 out of sample: ` +
    `${surviving.map(r => r.name).join(', ') || '(none)'}`);

  const minT = Number(process.env['MIN_T'] ?? 3);
  const survivors = ranked.filter(r => Math.abs(r.s[DISCOVERY].icT) >= minT);
  console.log(`\n═══ the same ${survivors.length} candidates (|t| >= ${minT}) across every cell ═══`);
  for (const r of survivors) {
    console.log(`\n  ${r.name}  (${r.family})`);
    console.log(`    cell         n        dates      IC      t      accAdj   spread(bp)    t    boot`);
    for (const cell of cells) {
      const s = r.s[cell.label];
      console.log(
        `    ${cell.label.padEnd(11)} ${String(s.n).padStart(8)} ${String(s.dates).padStart(8)} ` +
        `${f(s.ic, 4).padStart(8)} ${f(s.icT, 1).padStart(6)} ${pctf(s.accAdj).padStart(8)} ` +
        `${f(s.spreadBp, 0).padStart(10)} ${f(s.spreadT, 1).padStart(6)} ${pctf(s.icBootstrap).padStart(7)}`,
      );
    }
  }

  const dump = process.env['DUMP'];
  if (dump) {
    // Series are dropped: the per-date arrays are ~10k floats per cell per
    // candidate and nothing downstream reads them from the file.
    const slim: any = {};
    for (const [name, cellMap] of Object.entries(results)) {
      slim[name] = {};
      for (const [cell, s] of Object.entries(cellMap)) {
        const { icSeries, spreadSeries, dateSeries, ...rest } = s;
        slim[name][cell] = rest;
      }
    }
    fs.writeFileSync(dump, JSON.stringify({ era1: ERA1, era2: ERA2, horizon: HORIZON, activeFraction, results: slim }, null, 2));
    console.log(`\n  wrote ${dump}`);
  }
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
