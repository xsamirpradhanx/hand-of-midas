import 'dotenv/config';
/**
 * Read-only report on what the learning loop has actually measured.
 *
 *   npm run quant-report --workspace=backend
 *
 * Answers the questions evaluate-quant's log does not: what is the win rate by
 * direction, which setups carry the losses, and how much of the promised R the
 * engine actually delivers.
 *
 * Caveat on R figures: evaluateQuant credits a win the FULL planned rewardRisk
 * and debits a loss exactly 1.0 (see evaluateQuant.ts:229-235). These are modelled
 * expectancies assuming perfect fills at target and stop, so on illiquid names the
 * true figure is worse. Outcome rows carry no realizedR, so nothing here can
 * reconstruct actual fills.
 */
import { getItem, scanItems } from '../services/dynamodb.js';

async function main() {
  const fs: any = await getItem('SYSTEM', 'FACTOR_STATS');
  const ss: any = await getItem('SYSTEM', 'SETUP_STATS');
  const items: any[] = await scanItems({});
  const out = items.filter(i => i.outcome);

  const dec = out.filter(o => o.outcome !== 'AMBIGUOUS');
  const wins = dec.filter(o => o.outcome === 'TARGET').length;
  console.log(`\n═══ GRADED OUTCOMES ═══`);
  console.log(`  total ${out.length} | decided ${dec.length} | ambiguous ${out.length - dec.length} (${(( out.length-dec.length)/out.length*100).toFixed(1)}%)`);
  console.log(`  WIN RATE (decided): ${wins}/${dec.length} = ${(wins / dec.length * 100).toFixed(1)}%`);

  const byBias: Record<string, { w: number; n: number }> = {};
  for (const o of dec) {
    const k = o.bias ?? o.setupType ?? '?';
    byBias[k] ??= { w: 0, n: 0 };
    byBias[k].n++;
    if (o.outcome === 'TARGET') byBias[k].w++;
  }
  console.log(`\n═══ BY SETUP / BIAS ═══`);
  for (const [k, v] of Object.entries(byBias).sort((a, b) => b[1].n - a[1].n).slice(0, 10)) {
    console.log(`  ${String(k).slice(0, 34).padEnd(34)} ${String(v.w).padStart(4)}/${String(v.n).padEnd(5)} = ${(v.w / v.n * 100).toFixed(1)}%`);
  }

  console.log(`\n═══ FACTOR STATS ═══`);
  const stats = fs?.stats ?? fs?.factors ?? {};
  const rows = Object.entries(stats) as [string, any][];
  if (!rows.length) { console.log('  (empty)'); }
  for (const [name, v] of rows.sort((a, b) => (b[1].tries ?? 0) - (a[1].tries ?? 0)).slice(0, 25)) {
    const tries = v.tries ?? (v.wins ?? 0) + (v.losses ?? 0);
    const wr = tries ? ((v.wins ?? 0) / tries * 100).toFixed(1) : '—';
    console.log(`  ${name.slice(0, 44).padEnd(44)} n=${String(tries).padStart(5)}  win=${String(wr).padStart(5)}%  score=${(v.score ?? 0).toFixed?.(3) ?? v.score}`);
  }
  // Cross-tab of direction x setupType, recovered by joining outcomes back to
  // their prediction — outcome rows do not carry setupType themselves.
  const predIndex = new Map<string, any>();
  for (const p of items.filter(i => String(i.pk).startsWith('PREDICTION'))) {
    predIndex.set(`${p.symbol}|${p.sk}`, p);
  }
  const cell: Record<string, { n: number; w: number }> = {};
  for (const o of out) {
    if (o.outcome === 'AMBIGUOUS') continue;
    const p = predIndex.get(`${o.symbol}|${o.sk}`);
    const setup = p?.setupType ?? o.setupType;
    const dir = p?.aiThesis?.tradePlan?.bias ?? o.bias;
    if (!setup || !dir) continue;
    const k = `${dir}|${setup}`;
    cell[k] ??= { n: 0, w: 0 };
    cell[k].n++;
    if (o.outcome === 'TARGET') cell[k].w++;
  }
  console.log(`\n═══ DIRECTION x SETUP (decided only, n>=5) ═══`);
  for (const [k, v] of Object.entries(cell).filter(([, v]) => v.n >= 5).sort((a, b) => b[1].n - a[1].n)) {
    const wr = (v.w / v.n * 100).toFixed(1);
    const flag = v.w === 0 ? '  <-- never wins' : '';
    console.log(`  ${k.padEnd(32)} ${String(v.n).padStart(4)} decided  ${String(v.w).padStart(4)} wins  ${wr.padStart(6)}%${flag}`);
  }

  console.log(`\n═══ SETUP STATS ═══`);
  const sstats = ss?.stats ?? ss?.setups ?? {};
  const srows = Object.entries(sstats) as [string, any][];
  if (!srows.length) console.log('  (empty)');
  for (const [name, v] of srows.slice(0, 12)) console.log(`  ${name}:`, JSON.stringify(v));
}
main().catch(e => { console.error(e); process.exit(1); });
