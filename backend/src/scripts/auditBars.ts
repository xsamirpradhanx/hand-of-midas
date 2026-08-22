import 'dotenv/config';
/**
 * Audit the local bar mirror against Yahoo and write a per-symbol verdict.
 *
 *   npm run audit-bars --workspace=backend
 *   SYMS=COST,COP npm run audit-bars --workspace=backend
 *
 * Writes `bar-integrity.json`, which the indicator lab reads to decide how far
 * back each symbol's history can be trusted. Re-run after any backfill.
 *
 * Yahoo is the reference because its chart close carries the same convention
 * the store claims — split-adjusted, not dividend-adjusted — so agreement is a
 * plain 1.00x ratio and a defect shows as a departure that grows into the past.
 */
import fs from 'node:fs';
import { yf } from '../services/yahoo.js';
import { cachedSymbols, DEFAULT_CACHE_DIR } from '../services/backtest/barCache.js';
import {
  INTEGRITY_FILE, RETURN_TOLERANCE, storedCloses, verdictFor,
  type IntegrityReport, type SymbolVerdict,
} from '../services/backtest/barIntegrity.js';

async function referenceCloses(symbol: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  // ^VIX and similar index symbols are carried in the store for regime work and
  // have no comparable Yahoo chart under the same ticker convention.
  const quotes = await yf.chart(symbol, { period1: '1980-01-01', period2: new Date(), interval: '1d' })
    .then(r => r.quotes)
    .catch(() => [] as any[]);
  for (const q of quotes) {
    if (q?.close != null && q?.date != null) map.set(new Date(q.date).toISOString().slice(0, 10), q.close);
  }
  return map;
}

async function main() {
  const only = process.env['SYMS']?.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const symbols = only ?? cachedSymbols(DEFAULT_CACHE_DIR, '1day');
  const verdicts: Record<string, SymbolVerdict> = {};

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    process.stderr.write(`\r  ${i + 1}/${symbols.length}  ${symbol.padEnd(8)}`);
    const bars = storedCloses(symbol, DEFAULT_CACHE_DIR);
    if (!bars.length) continue;
    const ref = await referenceCloses(symbol);
    verdicts[symbol] = verdictFor(symbol, bars, ref, RETURN_TOLERANCE);
  }
  process.stderr.write('\r' + ' '.repeat(40) + '\r');

  const report: IntegrityReport = {
    auditedAt: new Date().toISOString(),
    tolerance: RETURN_TOLERANCE,
    symbols: verdicts,
  };
  fs.writeFileSync(INTEGRITY_FILE, JSON.stringify(report, null, 2));

  const all = Object.values(verdicts);
  const by = (v: string) => all.filter(x => x.verdict === v);
  console.log(`\n═══ bar store integrity — ${all.length} symbols vs Yahoo (return tolerance ${(RETURN_TOLERANCE * 100).toFixed(1)}%/day) ═══\n`);
  console.log(`  clean       ${by('clean').length}`);
  console.log(`  truncated   ${by('truncated').length}   (history usable only after a date)`);
  console.log(`  unusable    ${by('unusable').length}`);
  console.log(`  unchecked   ${by('unchecked').length}   (no comparable Yahoo history)\n`);

  const damaged = [...by('truncated'), ...by('unusable')].sort((a, b) => b.droppedBars - a.droppedBars);
  if (damaged.length) {
    console.log('  symbol   verdict      worst err     drop     trusted from');
    for (const v of damaged) {
      console.log(
        `  ${v.symbol.padEnd(8)} ${v.verdict.padEnd(11)} ${(v.worstError * 100).toFixed(0).padStart(9)}% ` +
        `${String(v.droppedBars).padStart(8)}     ${v.trustedFrom ?? '(none)'}`,
      );
    }
    const totalDropped = damaged.reduce((a, v) => a + v.droppedBars, 0);
    console.log(`\n  ${totalDropped.toLocaleString()} bars quarantined across ${damaged.length} symbols`);
  }
  const unchecked = by('unchecked');
  if (unchecked.length) console.log(`\n  unchecked: ${unchecked.map(v => v.symbol).join(', ')}`);
  console.log(`\n  wrote ${INTEGRITY_FILE}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
