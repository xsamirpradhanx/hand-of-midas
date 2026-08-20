import 'dotenv/config';
import { scanItems, putItem, getItem } from '../services/dynamodb.js';
import { fetchBarsWithFallback } from '../services/marketData/fetchBars.js';
import type { PredictionItem, EvaluationItem, FactorStatsItem, SetupStatsItem } from '../types.js';
import { learningKey } from '../services/quant/learningEngine.js';
import { gradeOutcome } from '../services/quant/gradeOutcome.js';

/**
 * Maximum hold a trade plan is graded over, in daily bars — 20 ≈ 4 calendar weeks.
 * Plans are swing/options setups measured in days-to-weeks; anything still unresolved
 * after 4 weeks is a TIMEOUT because the thesis no longer applies, not a loss.
 * Must stay in sync with HORIZON_BARS in services/compositeScore.ts, which sizes
 * target and stop distances — grading over a different window than plans are built
 * for is what previously produced setups that could not resolve meaningfully.
 */
const EVALUATION_HORIZON_BARS = 20;

export async function evaluateQuant() {
  console.log('[Quant Evaluation] 📊 Starting prediction evaluation cycle...');

  try {
    // 1. Fetch all predictions from DynamoDB
    console.log('[Quant Evaluation] 🔍 Scanning for past predictions...');
    const predictions = await scanItems<PredictionItem>({
      FilterExpression: 'begins_with(pk, :prefix)',
      ExpressionAttributeValues: {
        ':prefix': 'PREDICTION#'
      }
    });

    if (predictions.length === 0) {
      console.log('[Quant Evaluation] ℹ️ No predictions found to evaluate.');
      return;
    }

    let factorStatsItem = await getItem<FactorStatsItem>('SYSTEM', 'FACTOR_STATS');
    if (!factorStatsItem) {
      factorStatsItem = {
        pk: 'SYSTEM',
        sk: 'FACTOR_STATS',
        stats: {},
        updatedAt: new Date().toISOString()
      };
    }
    const factorStats = factorStatsItem.stats;

    let setupStatsItem = await getItem<SetupStatsItem>('SYSTEM', 'SETUP_STATS');
    if (!setupStatsItem) {
      setupStatsItem = {
        pk: 'SYSTEM',
        sk: 'SETUP_STATS',
        stats: {},
        updatedAt: new Date().toISOString()
      };
    }
    const setupStats = setupStatsItem.stats;

    console.log(`[Quant Evaluation] 📝 Found ${predictions.length} prediction(s) to process.`);

    const now = new Date();
    const evaluatedAt = now.toISOString();

    // 2. Process each prediction
    for (const pred of predictions) {
      const predDate = new Date(pred.createdAt);
      
      const daysOld = (now.getTime() - predDate.getTime()) / (1000 * 3600 * 24);
      
      console.log(`\n[Quant Evaluation] ------------------------------------------------`);
      console.log(`[Quant Evaluation] Evaluating ${pred.symbol} from ${pred.createdAt} (${daysOld.toFixed(1)} days old)`);

      const thesis = pred.aiThesis;
      if (!thesis || !thesis.tradePlan) {
        console.log(`[Quant Evaluation] ⚠️ No trade plan found for ${pred.symbol}, skipping.`);
        continue;
      }

      const bias = thesis.tradePlan.bias;
      // Namespaces every learning key below. The screener writes predictions on
      // every scan (open/premarket every 5m, momentum/highdemand every 2m) while
      // the AI Trade Plan writes once per day per symbol — sharing one keyspace
      // let screener volume bury the Trade Plan's outcomes by orders of
      // magnitude, so the swing engine calibrated largely on intraday results.
      // Rows predating the field are LEGACY and stay in their own partition
      // rather than being guessed into one engine or the other.
      const source = pred.source ?? 'LEGACY';
      if (bias === 'NO TRADE') {
        console.log(`[Quant Evaluation] ⏭️ Bias was NO TRADE, skipping grading.`);
        continue;
      }

      const entryPrice = pred.currentPrice;
      // Prefer the target snapshot written with the prediction. Plan defaults
      // may evolve later, but a historical grade must use the original terms.
      // majorResistance is T1 for both LONG and SHORT — the level rewardRisk is
      // actually computed from — so it's the correct fallback for legacy
      // predictions that predate persisting `target` (stretchTarget/T2 would
      // grade SHORT trades against a farther level than promised).
      const target = pred.target ?? thesis.tradePlan.majorResistance;
      const stop = thesis.tradePlan.stop;

      if (!target || !stop) {
        console.log(`[Quant Evaluation] ⚠️ Trade plan missing target/stop, skipping.`);
        continue;
      }

      const evaluationPk = `EVALUATION#${pred.symbol}`;
      const evaluationSk = `TIMESTAMP#${pred.createdAt}`;
      const existingEvaluation = await getItem<EvaluationItem>(evaluationPk, evaluationSk);
      // Learning is append-only: a finalized observation must never be counted twice.
      if (existingEvaluation?.isFinal) {
        console.log(`[Quant Evaluation] ✓ Already finalized; skipping.`);
        continue;
      }

      console.log(`[Quant Evaluation] 🎯 Plan: ${bias} @ ${entryPrice.toFixed(2)} | Target: ${target.toFixed(2)} | Stop: ${stop.toFixed(2)}`);

      // 3. Fetch recent price action (Schwab primary, Yahoo fallback).
      // fetchBarsWithFallback throws when every provider returns zero bars
      // (e.g. a delisted/bad ticker) — unlike the old direct Yahoo call, which
      // just returned []. Isolate that per-prediction so one bad symbol can't
      // abort grading for every other prediction in this run.
      const historyNeeded = Math.min(252, Math.max(20, Math.ceil(daysOld) + EVALUATION_HORIZON_BARS + 5));
      let bars;
      try {
        ({ bars } = await fetchBarsWithFallback(pred.symbol, '1day', historyNeeded));
      } catch (err) {
        console.warn(`[Quant Evaluation] ⚠️ Could not fetch bars for ${pred.symbol}, skipping: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const futureBars = bars.filter(b => new Date(b.datetime).getTime() > predDate.getTime());

      const grade = gradeOutcome(
        futureBars,
        target,
        stop,
        bias as 'LONG' | 'SHORT' | 'BEARISH',
        entryPrice,
        EVALUATION_HORIZON_BARS,
      );

      // Only an unresolved plan needs the full horizon. TARGET/STOP/AMBIGUOUS mean a
      // level was actually touched, and no number of later bars can un-touch it — so
      // those grade as soon as they happen. Waiting for the whole window regardless
      // (the previous behaviour) would have delayed every single grade by the full
      // EVALUATION_HORIZON_BARS, throttling the learning loop to one batch of feedback
      // per horizon rather than grading each plan the day it resolves.
      if (grade.outcome === 'TIMEOUT' && futureBars.length < EVALUATION_HORIZON_BARS) {
        console.log(`[Quant Evaluation] ⏳ Unresolved after ${futureBars.length}/${EVALUATION_HORIZON_BARS} bars — waiting.`);
        continue;
      }
      const { outcome, score, hitTarget, hitStop, maxExcursion, ambiguous } = grade;

      if (outcome === 'TARGET') {
        console.log(`[Quant Evaluation] 🟢 WIN! Hit target of ${target.toFixed(2)}.`);
      } else if (outcome === 'STOP') {
        console.log(`[Quant Evaluation] 🔴 LOSS! Hit stop loss of ${stop.toFixed(2)}.`);
      } else if (outcome === 'AMBIGUOUS') {
        // Same-bar target+stop hits; intrabar order unknowable from daily OHLC.
        // Excluded from wins/losses so calibration is not biased.
        console.log(`[Quant Evaluation] ⚠️ AMBIGUOUS. Bar spanned both target ${target.toFixed(2)} and stop ${stop.toFixed(2)}; excluded from win/loss.`);
      } else {
        console.log(`[Quant Evaluation] ⚪ TIMEOUT after ${EVALUATION_HORIZON_BARS} bars. Max favorable excursion: ${(maxExcursion * 100).toFixed(2)}%`);
      }

      // 4. Save evaluation back to DynamoDB
      const evalItem: EvaluationItem = {
        pk: evaluationPk,
        sk: evaluationSk,
        symbol: pred.symbol,
        predictionTimestamp: pred.createdAt,
        evaluatedAt,
        bias,
        score,
        hitStop,
        hitTarget,
        maxExcursion,
        isFinal: true,
        horizonBars: EVALUATION_HORIZON_BARS,
        outcome,
      };

      await putItem(evalItem);
      console.log(`[Quant Evaluation] 💾 Saved evaluation for ${pred.symbol} to database.`);

      if (thesis.factors && Array.isArray(thesis.factors)) {
        for (const f of thesis.factors) {
          const fname = `${source}|${f.factorName}`;
          if (!factorStats[fname]) {
            factorStats[fname] = { tries: 0, wins: 0, losses: 0, score: 0, ambiguous: 0 };
          }
          const fs = factorStats[fname];
          fs.tries = (fs.wins ?? 0) + (fs.losses ?? 0) + (fs.ambiguous ?? 0) + 1;
          if (ambiguous) {
            // Excluded from score/wins/losses so calibration is unbiased.
            fs.ambiguous = (fs.ambiguous ?? 0) + 1;
          } else {
            fs.score += score;
            if (outcome === 'TARGET') fs.wins += 1;
            else fs.losses += 1;
          }
        }
      }

      // 5. P2: Record setup-specific empirical stats.
      // Namespaced by engine: the screener writes predictions on every scan
      // (open/premarket every 5m, momentum/highdemand every 2m — several
      // hundred scans a session), while the AI Trade Plan writes once per day
      // per symbol. Sharing one keyspace let screener volume bury the Trade
      // Plan's outcomes by orders of magnitude, so the swing engine was
      // effectively calibrating on intraday results.
      const setupKey = pred.marketRegime && pred.setupType
        ? `${source}|${pred.marketRegime}|${pred.setupType}`
        : undefined;
      const keys = [`${source}|${learningKey(bias)}`, ...(setupKey ? [setupKey] : [])];
      for (const key of keys) {
        if (!setupStats[key]) {
          setupStats[key] = { tries: 0, wins: 0, losses: 0, sumExpectedR: 0, sumActualR: 0, ambiguous: 0 };
        }
        const stat = setupStats[key];

        stat.tries = (stat.wins ?? 0) + (stat.losses ?? 0) + (stat.ambiguous ?? 0) + 1;

        if (ambiguous) {
          // Neither expected nor actual R accumulate; simply mark the outcome.
          stat.ambiguous = (stat.ambiguous ?? 0) + 1;
        } else if (thesis.tradePlan.rewardRisk) {
          stat.sumExpectedR += thesis.tradePlan.rewardRisk;
          if (outcome === 'TARGET') {
            stat.wins += 1;
            stat.sumActualR += thesis.tradePlan.rewardRisk;
          } else {
            stat.losses += 1;
            stat.sumActualR -= 1.0;
          }
        }
      }
    }

    await putItem({ ...factorStatsItem, updatedAt: new Date().toISOString() });
    console.log('[Quant Evaluation] 📈 Updated FACTOR_STATS with new performance data.');

    await putItem({ ...setupStatsItem, updatedAt: new Date().toISOString() });
    console.log('[Quant Evaluation] 📈 Updated SETUP_STATS with new empirical expectancy data.');

    console.log('\n[Quant Evaluation] ✨ Evaluation cycle complete.');

  } catch (err) {
    console.error('[Quant Evaluation] ❌ Error during evaluation:', err);
  }
}

// No self-invocation here — this module is imported by both the CLI entry
// point (scripts/runEvaluateQuant.ts) and the scheduled Lambda handler
// (handlers/evaluateQuant.ts), each of which calls evaluateQuant() explicitly.
// A bottom-of-file self-invoking call would also fire on Lambda cold start.
