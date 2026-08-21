import 'dotenv/config';
/** Dump the derived stat aggregates to a file so a rebuild is reversible. */
import fs from 'node:fs';
import { getItem } from '../services/dynamodb.js';
const out = {
  savedAt: new Date().toISOString(),
  SETUP_STATS: await getItem('SYSTEM', 'SETUP_STATS'),
  FACTOR_STATS: await getItem('SYSTEM', 'FACTOR_STATS'),
};
const path = process.argv[2] ?? `stats-backup-${Date.now()}.json`;
fs.writeFileSync(path, JSON.stringify(out, null, 2));
console.log(`saved -> ${path}`);
