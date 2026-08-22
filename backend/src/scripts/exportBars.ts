import 'dotenv/config';
/**
 * Mirror the DynamoDB daily bar store to the local research cache.
 *
 *   npm run export-bars --workspace=backend
 *   FORCE=1 npm run export-bars --workspace=backend     # re-read symbols already cached
 *   SYMS=AAPL,NVDA npm run export-bars --workspace=backend
 *
 * Run this once after a backfill. Everything in the indicator lab reads the
 * mirror, not Dynamo.
 */
import { exportCache, DEFAULT_CACHE_DIR } from '../services/backtest/barCache.js';

async function main() {
  const symbols = process.env['SYMS']?.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const started = Date.now();
  const result = await exportCache({
    symbols,
    force: process.env['FORCE'] === '1',
    onProgress: p => {
      if (p.index % 10 === 0 || p.index === p.total - 1) {
        process.stderr.write(`\r  ${p.index + 1}/${p.total}  ${p.symbol.padEnd(6)}`);
      }
    },
  });
  process.stderr.write('\r');
  console.log(`\nmirrored ${result.symbols} symbols / ${result.bars.toLocaleString()} bars in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  -> ${DEFAULT_CACHE_DIR}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
