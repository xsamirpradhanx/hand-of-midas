import 'dotenv/config';
/**
 * Rebuild SETUP_STATS and FACTOR_STATS from raw rows, deduplicated by plan.
 *
 *   npm run rebuild-stats --workspace=backend            # dry run, prints the diff
 *   npm run rebuild-stats --workspace=backend -- --apply # writes
 *
 * Why this exists: screenerService wrote a fresh PREDICTION row on every scan
 * pass (four modes, every 2-5 minutes), so one symbol camping on the scanner
 * produced up to 159 identical rows. evaluateQuant grades every row
 * independently, so the learning stats ended up weighted by how long a ticker sat
 * on the scanner rather than by how often a thesis was right — SLE alone supplied
 * 184 of 1,043 graded outcomes, all the same losing plan.
 *
 * The write path is fixed going forward, but evaluateQuant's isFinal guard means
 * already-graded rows are never revisited, so the corrupted aggregates are frozen
 * in place. This recomputes them from the raw PREDICTION + EVALUATION rows,
 * collapsing every duplicate of a plan to a single vote. Raw rows are never
 * modified; only the two derived aggregates are rewritten.
 */
import { getItem, putItem, scanItems } from '../services/dynamodb.js';
import { realizedDirection, factorWasCorrect } from '../services/quant/factorAttribution.js';

const APPLY = process.argv.includes('--apply');

interface Stat { tries: number; wins: number; losses: number; ambiguous: number; sumExpectedR: number; sumActualR: number }
const blank = (): Stat => ({ tries: 0, wins: 0, losses: 0, ambiguous: 0, sumExpectedR: 0, sumActualR: 0 });

/** Distinct plan identity — the unit a thesis should be judged on, once. */
const planKey = (p: any) =>
  [p.symbol, String(p.createdAt ?? '').slice(0, 10), p.entry, p.stop, p.target,
   p.aiThesis?.tradePlan?.bias ?? '?'].join('|');

async function main() {
  const items: any[] = await scanItems({});
  const preds = items.filter(i => String(i.pk).startsWith('PREDICTION'));
  const evals = items.filter(i => i.outcome);

  const predBySk = new Map<string, any>();
  for (const p of preds) predBySk.set(`${p.symbol}|${p.sk}`, p);

  // Collapse duplicates: one vote per distinct plan. Keep the earliest graded
  // row for a plan — the first signal is the one that could have been acted on.
  const seen = new Map<string, { ev: any; pred: any }>();
  let orphans = 0;
  for (const ev of evals) {
    const pred = predBySk.get(`${ev.symbol}|${ev.sk}`);
    if (!pred) { orphans++; continue; }
    const k = planKey(pred);
    const prev = seen.get(k);
    if (!prev || String(pred.createdAt) < String(prev.pred.createdAt)) seen.set(k, { ev, pred });
  }

  const setupStats: Record<string, Stat> = {};
  const factorStats: Record<string, {
    wins: number; losses: number; tries: number; score: number; ambiguous: number;
    bullishVotes: number; bullishWins: number; bearishVotes: number; bearishWins: number;
  }> = {};

  for (const { ev, pred } of seen.values()) {
    const thesis = pred.aiThesis;
    const bias = thesis?.tradePlan?.bias;
    if (!bias || bias === 'NO TRADE') continue;
    const source = pred.source ?? 'LEGACY';
    const rr = thesis.tradePlan.rewardRisk;
    const ambiguous = ev.outcome === 'AMBIGUOUS';
    const won = ev.outcome === 'TARGET';

    const setupKey = pred.marketRegime && pred.setupType
      ? `${source}|${pred.marketRegime}|${pred.setupType}` : undefined;
    for (const key of [`${source}|GLOBAL|${bias}`, ...(setupKey ? [setupKey] : [])]) {
      const st = (setupStats[key] ??= blank());
      st.tries++;
      if (ambiguous) { st.ambiguous++; continue; }
      if (!rr) continue;
      st.sumExpectedR += rr;
      if (won) { st.wins++; st.sumActualR += rr; } else { st.losses++; st.sumActualR -= 1.0; }
    }

    // Same directional attribution the live evaluator uses — a rebuild that
    // scored factors differently from production would measure a system nobody runs.
    const realized = realizedDirection(bias, ev.outcome);
    for (const f of thesis.factors ?? []) {
      const fk = `${source}|${f.factorName}`;
      const fs = (factorStats[fk] ??= {
        wins: 0, losses: 0, tries: 0, score: 0, ambiguous: 0,
        bullishVotes: 0, bullishWins: 0, bearishVotes: 0, bearishWins: 0,
      });
      fs.tries++;
      const correct = realized ? factorWasCorrect(f.bias, realized) : null;
      if (correct === null) fs.ambiguous++;
      else if (correct) { fs.wins++; fs.score++; }
      else fs.losses++;
      // Direction split, so a rebuild produces records the informedness metric
      // can actually score rather than ones it has to skip.
      if (correct !== null) {
        if (f.bias === 'bullish') { fs.bullishVotes++; if (correct) fs.bullishWins++; }
        else if (f.bias === 'bearish') { fs.bearishVotes++; if (correct) fs.bearishWins++; }
      }
    }
  }

  const oldSetup: any = await getItem('SYSTEM', 'SETUP_STATS');
  const oldFactor: any = await getItem('SYSTEM', 'FACTOR_STATS');

  console.log(`\nEVALUATION rows ${evals.length} | matched to a prediction ${evals.length - orphans} | orphaned ${orphans}`);
  console.log(`DISTINCT plans after dedupe: ${seen.size}  (${(evals.length / Math.max(1, seen.size)).toFixed(1)}x inflation removed)\n`);

  console.log('SETUP_STATS — before -> after (tries / wins / sumActualR)');
  const keys = new Set([...Object.keys(oldSetup?.stats ?? {}), ...Object.keys(setupStats)]);
  for (const k of [...keys].sort()) {
    const o = oldSetup?.stats?.[k];
    const n = setupStats[k];
    const f = (s: any) => s ? `${s.tries}/${s.wins}/${(s.sumActualR ?? 0).toFixed(1)}` : '—';
    if (f(o) === f(n)) continue;
    console.log(`  ${k.padEnd(38)} ${f(o).padStart(18)}  ->  ${f(n)}`);
  }

  const totalOld = Object.values(oldSetup?.stats ?? {}).reduce((s: number, v: any) => s + (v.tries ?? 0), 0);
  const totalNew = Object.values(setupStats).reduce((s, v) => s + v.tries, 0);
  console.log(`\ntotal setup tries: ${totalOld} -> ${totalNew}`);
  console.log(`factor stat keys : ${Object.keys(oldFactor?.stats ?? {}).length} -> ${Object.keys(factorStats).length}`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with -- --apply to persist.\n');
    return;
  }
  await putItem({ pk: 'SYSTEM', sk: 'SETUP_STATS', stats: setupStats, updatedAt: new Date().toISOString() } as any);
  await putItem({ pk: 'SYSTEM', sk: 'FACTOR_STATS', stats: factorStats, updatedAt: new Date().toISOString() } as any);
  console.log('\n✅ Rebuilt SETUP_STATS and FACTOR_STATS from deduplicated plans.\n');
}
main().catch(e => { console.error(e); process.exit(1); });
