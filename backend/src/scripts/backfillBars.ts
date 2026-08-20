/**
 * Sequential historical bar backfill: Schwab → DynamoDB.
 *
 *   npm run backfill-bars                          # full universe, 30y daily
 *   npm run backfill-bars -- --tier=core,benchmark # one slice
 *   npm run backfill-bars -- --symbols=AAPL,SPY
 *   npm run backfill-bars -- --years=40 --force    # ignore stored coverage
 *   npm run backfill-bars -- --incremental         # only bars newer than stored
 *   npm run backfill-bars -- --dry-run             # fetch, report, write nothing
 *
 * Sequential on purpose. Schwab allows ~120 requests/minute and returns a
 * symbol's entire listed history in a single response, so the whole job is one
 * request per symbol — roughly 40 seconds for a 90-symbol universe. Parallelism
 * would buy nothing and risk a 429 mid-run.
 *
 * Resumable: coverage is recorded per symbol as it completes, so a crashed run
 * re-run without --force skips whatever already landed.
 */
import 'dotenv/config';

import 'dotenv/config';
import { fetchHistoryRange } from '../services/marketData/schwabHistory.js';
import { putBars, getCoverage } from '../services/backtest/barStore.js';
import { resolveUniverse, type UniverseTier, type UniverseEntry } from '../services/backtest/backfillUniverse.js';
import type { BarInterval } from '../services/marketData/fetchBars.js';

interface Args {
  symbols: string[] | null;
  tiers: UniverseTier[] | null;
  years: number;
  interval: BarInterval;
  force: boolean;
  incremental: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined =>
    argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const has = (name: string): boolean => argv.includes(`--${name}`);

  return {
    symbols: get('symbols')?.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) ?? null,
    tiers: (get('tier') ?? get('tiers'))?.split(',').map(s => s.trim()) as UniverseTier[] | undefined ?? null,
    years: Number(get('years') ?? 30),
    interval: (get('interval') ?? '1day') as BarInterval,
    force: has('force'),
    incremental: has('incremental'),
    dryRun: has('dry-run'),
  };
}

interface SymbolOutcome {
  symbol: string;
  tier: string;
  status: 'written' | 'skipped' | 'empty' | 'failed';
  bars: number;
  first: string;
  last: string;
  detail: string;
}

const DAY_MS = 86_400_000;
const iso = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const universe: UniverseEntry[] = args.symbols
    ? args.symbols.map(symbol => ({ symbol, tier: 'core' as const, role: 'explicit --symbols' }))
    : await resolveUniverse(args.tiers ? { tiers: args.tiers } : {});

  const now = Date.now();
  const rangeStart = now - args.years * 365.25 * DAY_MS;

  console.log(
    `Backfilling ${universe.length} symbols @ ${args.interval}, ` +
      `${args.years}y window (${iso(rangeStart)} → ${iso(now)})` +
      `${args.dryRun ? ' [DRY RUN]' : ''}${args.incremental ? ' [INCREMENTAL]' : ''}`,
  );

  const outcomes: SymbolOutcome[] = [];
  const startedAt = Date.now();

  for (const [i, entry] of universe.entries()) {
    const { symbol, tier } = entry;
    const progress = `[${String(i + 1).padStart(3)}/${universe.length}]`;

    try {
      const coverage = await getCoverage(symbol, args.interval);
      let start = rangeStart;

      if (coverage && !args.force) {
        if (args.incremental) {
          // Re-fetch the last stored session too: the final bar of a partial
          // day is provisional, and merge-on-write corrects it in place.
          start = Math.max(rangeStart, coverage.lastTs - DAY_MS);
        } else if (coverage.firstTs <= rangeStart + 7 * DAY_MS && coverage.lastTs >= now - 4 * DAY_MS) {
          // Already covers the requested window (7d slack at the start for
          // symbols that simply IPO'd later, 4d at the end for weekends).
          outcomes.push({
            symbol, tier, status: 'skipped', bars: coverage.barCount,
            first: iso(coverage.firstTs), last: iso(coverage.lastTs),
            detail: 'coverage already satisfies window',
          });
          console.log(`${progress} ${symbol.padEnd(6)} skip   ${coverage.barCount} bars stored`);
          continue;
        }
      }

      const result = await fetchHistoryRange(symbol, args.interval, start, now, {
        extendedHours: false,
      });

      if (result.bars.length === 0) {
        outcomes.push({
          symbol, tier, status: 'empty', bars: 0, first: '-', last: '-',
          detail: `${result.provider} returned no bars — delisted, wrong ticker, or index without history`,
        });
        console.log(`${progress} ${symbol.padEnd(6)} EMPTY  (${result.provider})`);
        continue;
      }

      const first = result.bars[0]!.timestamp;
      const last = result.bars[result.bars.length - 1]!.timestamp;

      if (args.dryRun) {
        outcomes.push({
          symbol, tier, status: 'written', bars: result.bars.length,
          first: iso(first), last: iso(last), detail: 'dry run — not written',
        });
        console.log(`${progress} ${symbol.padEnd(6)} ${String(result.bars.length).padStart(6)} bars  ${iso(first)} → ${iso(last)}  (dry)`);
        continue;
      }

      const written = await putBars(symbol, args.interval, result.bars, result.provider, {
        // A symbol with no stored coverage cannot have anything to merge with,
        // and skipping the per-chunk reads halves the cost of a first load.
        mode: coverage && !args.force ? 'merge' : 'overwrite',
      });

      outcomes.push({
        symbol, tier, status: 'written', bars: result.bars.length,
        first: iso(first), last: iso(last),
        detail: `${written.chunksWritten} chunks via ${result.provider}`,
      });
      console.log(
        `${progress} ${symbol.padEnd(6)} ${String(result.bars.length).padStart(6)} bars  ` +
          `${iso(first)} → ${iso(last)}  ${written.chunksWritten} chunks`,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      outcomes.push({ symbol, tier, status: 'failed', bars: 0, first: '-', last: '-', detail });
      console.error(`${progress} ${symbol.padEnd(6)} FAILED ${detail}`);
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const by = (status: SymbolOutcome['status']) => outcomes.filter(o => o.status === status);
  const totalBars = outcomes.reduce((sum, o) => sum + o.bars, 0);

  console.log(`\n── Backfill complete in ${elapsed}s ──`);
  console.log(`written ${by('written').length}  skipped ${by('skipped').length}  empty ${by('empty').length}  failed ${by('failed').length}`);
  console.log(`${totalBars.toLocaleString()} bars total`);

  if (by('empty').length) {
    console.log(`\nNo data returned for: ${by('empty').map(o => o.symbol).join(', ')}`);
    console.log('  Schwab returns nothing for delisted tickers and index symbols — a real');
    console.log('  survivorship-bias source, not a transient failure.');
  }
  if (by('failed').length) {
    console.log('\nFailures:');
    for (const o of by('failed')) console.log(`  ${o.symbol}: ${o.detail}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
