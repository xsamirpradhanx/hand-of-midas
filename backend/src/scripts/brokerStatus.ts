import 'dotenv/config';
/**
 * Print local broker connection state.
 *
 *   npm run broker-status --workspace=backend
 *
 * Answers "is Schwab actually connected right now, and for how much longer"
 * without starting the app or opening the UI.
 */
import { schwabFor } from '../services/brokers/index.js';

function human(ms: number): string {
  if (ms <= 0) return 'expired';
  const h = ms / 3_600_000;
  return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
}

async function main() {
  const s = await schwabFor().status();
  const mark = s.connected ? '✅' : '❌';
  console.log(`\n${mark} schwab — ${s.connected ? 'connected' : 'not connected'}`);
  if (s.accessExpiresAt) {
    console.log(`   access token : ${human(s.accessExpiresAt - Date.now())} left`);
  }
  if (s.refreshExpiresAt) {
    console.log(`   refresh grant: ${human(s.refreshExpiresAt - Date.now())} left`);
  }
  if (s.reason) console.log(`   reason       : ${s.reason}`);
  if (s.needsReauth) {
    console.log('\n   Reconnect with: npm run schwab-auth --workspace=backend');
  }
  console.log();
}

main().catch(e => { console.error('❌', e?.message ?? e); process.exit(1); });
