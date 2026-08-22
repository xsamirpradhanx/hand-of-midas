import 'dotenv/config';
/**
 * Fetch and cache the FRED series this project uses.
 *
 *   npm run fetch-fred --workspace=backend
 *   FORCE=1 npm run fetch-fred --workspace=backend
 */
import { FRED_SERIES, fetchSeries, FRED_CACHE_DIR } from '../services/marketData/fred.js';

async function main() {
  const force = process.env['FORCE'] === '1';
  console.log('');
  for (const [id, desc] of Object.entries(FRED_SERIES)) {
    try {
      const s = await fetchSeries(id, { force });
      const valued = s.points.filter(p => p.value !== null);
      const first = valued[0]?.date ?? '—';
      const last = valued[valued.length - 1]?.date ?? '—';
      console.log(`  ${id.padEnd(14)} ${String(valued.length).padStart(6)} obs  ${first} .. ${last}   ${desc}`);
    } catch (e: any) {
      console.log(`  ${id.padEnd(14)} FAILED: ${e.message}`);
    }
  }
  console.log(`\n  -> ${FRED_CACHE_DIR}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
