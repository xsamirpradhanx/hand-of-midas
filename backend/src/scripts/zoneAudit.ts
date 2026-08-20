/**
 * Zone Audit — point-in-time replay of the production zone/plan engine.
 *
 * For each symbol, rewinds to N historical decision bars, rebuilds the factor
 * set using ONLY bars visible at that instant, runs the SAME CompositeScoreAgent
 * used in production, then grades what actually happened over the next
 * HORIZON bars with the SAME gradeOutcome.
 *
 * Look-ahead is prevented by slicing bars before any factor sees them.
 *
 * Options/news/sentiment are unavailable historically, so OPTIONS + CATALYST
 * bucket factors go silent. Zones are unaffected (they are built only from
 * PRICE_STRUCTURE factors); conviction IS affected and is reported separately.
 */
import 'dotenv/config';
import { getFactors } from '../services/factors/factorRegistry.js';
import { fetchBarsWithFallback } from '../services/marketData/fetchBars.js';
import { CompositeScoreAgent } from '../services/compositeScore.js';
import { gradeOutcome } from '../services/quant/gradeOutcome.js';
import type { FactorInput } from '../services/factors/types.js';

const HORIZON = 20;
const WARMUP = 126;          // production fetches 126 daily bars
const STEP = Number(process.env.STEP ?? 10);
const POINTS = Number(process.env.POINTS ?? 8);
const OUT = process.env.OUT ?? '/tmp/zoneaudit.jsonl';

const SYMBOLS = (process.env.SYMS ?? '').split(',').filter(Boolean);

interface Row {
  symbol: string; asOf: string; spot: number; atrPct: number;
  bias: string; readiness: string; archetype: string; conviction: number;
  agreement: string; nFactors: number; nDirectional: number;
  demandTop: number; demandBot: number; demandConf: string[];
  supplyTop: number; supplyBot: number; supplyConf: string[];
  trigger: number; stop: number; t1: number; rr: number; potRR: number;
  // realized
  fwdRet: number | null;
  demandTouched: boolean; demandHeld: boolean | null;
  supplyTouched: boolean; supplyHeld: boolean | null;
  planOutcome: string | null; planScore: number | null; planR: number | null;
}

async function main() {
  const factors = getFactors();
  const agent = new CompositeScoreAgent();
  const fs = await import('node:fs');
  fs.writeFileSync(OUT, '');
  let done = 0;

  for (const sym of SYMBOLS) {
    let bars: any[];
    try {
      const need = WARMUP + STEP * POINTS + HORIZON + 10;
      ({ bars } = await fetchBarsWithFallback(sym, '1day', need, { preferredProvider: 'yahoo' }));
    } catch (e: any) { console.error(`${sym}: fetch failed ${e?.message}`); continue; }
    if (!bars || bars.length < WARMUP + HORIZON + STEP) {
      console.error(`${sym}: only ${bars?.length ?? 0} bars, need ${WARMUP + HORIZON + STEP}`); continue;
    }

    for (let p = 0; p < POINTS; p++) {
      // decision index counted back from the last bar that still has a full horizon after it
      const lastGradable = bars.length - 1 - HORIZON;
      const di = lastGradable - p * STEP;
      if (di < WARMUP) break;

      const visible = bars.slice(Math.max(0, di - WARMUP + 1), di + 1);   // inclusive of decision bar
      const future = bars.slice(di + 1, di + 1 + HORIZON);
      if (future.length < HORIZON) continue;
      const spot = visible[visible.length - 1].close;

      const input: FactorInput = {
        symbol: sym, currentPrice: spot, bars: visible,
        intradayBars: undefined, optionsChain: undefined,
        activeExpiry: undefined, sentiment: undefined, news: undefined,
      } as any;

      const results: any[] = [];
      for (const f of factors) {
        try { const r = await f.evaluate(input); if (r) results.push(r); } catch { /* factor unavailable */ }
      }
      if (results.length === 0) continue;

      let synth: any;
      try { synth = await agent.synthesize(sym, spot, results, visible, undefined, undefined); }
      catch (e: any) { console.error(`${sym} ${di}: synth failed ${e?.message}`); continue; }

      const plan = synth.tradePlan ?? {};
      const dz = synth.demandZone, sz = synth.supplyZone;

      const hi = Math.max(...future.map((b: any) => b.high));
      const lo = Math.min(...future.map((b: any) => b.low));
      const lastClose = future[future.length - 1].close;

      // Zone test: did price enter the zone, and did the zone hold?
      // demand holds if price traded into it but the horizon closed above its bottom
      const demandTouched = lo <= dz.top;
      const demandHeld = demandTouched ? (lastClose > dz.bottom) : null;
      const supplyTouched = hi >= sz.bottom;
      const supplyHeld = supplyTouched ? (lastClose < sz.top) : null;

      let planOutcome: string | null = null, planScore: number | null = null, planR: number | null = null;
      if (plan.bias === 'LONG' || plan.bias === 'SHORT') {
        const g = gradeOutcome(future as any, plan.majorResistance, plan.stop, plan.bias, plan.trigger, HORIZON);
        planOutcome = g.outcome; planScore = g.score; planR = (g as any).realizedR ?? null;
      }

      const atrPct = Math.abs(plan.expectedMove ?? 0) / spot / 0.35;
      const row: Row = {
        symbol: sym, asOf: String(visible[visible.length - 1].datetime).slice(0, 10), spot: +spot.toFixed(2),
        atrPct: +(atrPct * 100).toFixed(2),
        bias: plan.bias ?? 'NONE', readiness: plan.readiness ?? '-', archetype: plan.archetype ?? '-',
        conviction: synth.modelConviction, agreement: synth.agreementLevel,
        nFactors: results.length, nDirectional: results.filter((r: any) => r.bias !== 'neutral').length,
        demandTop: dz.top, demandBot: dz.bottom, demandConf: dz.confluence,
        supplyTop: sz.top, supplyBot: sz.bottom, supplyConf: sz.confluence,
        trigger: plan.trigger, stop: plan.stop, t1: plan.majorResistance,
        rr: plan.rewardRisk, potRR: plan.potentialRewardRisk,
        fwdRet: +(((lastClose - spot) / spot) * 100).toFixed(2),
        demandTouched, demandHeld, supplyTouched, supplyHeld,
        planOutcome, planScore, planR,
        ...(synth.zoneDebug ?? {}),
      } as any;
      fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
    }
    done++;
    console.error(`[${done}/${SYMBOLS.length}] ${sym} done`);
  }
  console.error('WROTE ' + OUT);
}
main();
