import 'dotenv/config';
import { scanItems, putItem, getItem } from '../services/dynamodb.js';
import { getTimeSeriesYahoo } from '../services/yahoo.js';
import type { PredictionItem, EvaluationItem, FactorStatsItem } from '../types.js';

async function evaluateQuant() {
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
      if (bias === 'NO TRADE') {
        console.log(`[Quant Evaluation] ⏭️ Bias was NO TRADE, skipping grading.`);
        continue;
      }

      const entryPrice = pred.currentPrice;
      const target = thesis.tradePlan.stretchTarget;
      const stop = thesis.tradePlan.stop;

      if (!target || !stop) {
        console.log(`[Quant Evaluation] ⚠️ Trade plan missing target/stop, skipping.`);
        continue;
      }

      console.log(`[Quant Evaluation] 🎯 Plan: ${bias} @ ${entryPrice.toFixed(2)} | Target: ${target.toFixed(2)} | Stop: ${stop.toFixed(2)}`);

      // 3. Fetch recent price action
      const bars = await getTimeSeriesYahoo(pred.symbol, '1d', 10);
      
      const futureBars = bars.filter(b => new Date(b.datetime).getTime() > predDate.getTime());

      if (futureBars.length === 0) {
        console.log(`[Quant Evaluation] ⏳ Not enough future data yet for ${pred.symbol}. Need at least 1 closing bar after prediction.`);
        continue;
      }

      let hitTarget = false;
      let hitStop = false;
      let maxExcursion = 0; 

      for (const bar of futureBars) {
        if (bias === 'LONG') {
          if (bar.low <= stop) hitStop = true;
          if (bar.high >= target) hitTarget = true;
          
          const excursion = (bar.high - entryPrice) / entryPrice;
          if (excursion > maxExcursion) maxExcursion = excursion;

        } else if (bias === 'SHORT' || bias === 'BEARISH') { // fallback for 'BEARISH' just in case
          if (bar.high >= stop) hitStop = true;
          if (bar.low <= target) hitTarget = true;

          const excursion = (entryPrice - bar.low) / entryPrice;
          if (excursion > maxExcursion) maxExcursion = excursion;
        }

        if (hitStop || hitTarget) {
          break;
        }
      }

      let score = 0;
      if (hitTarget && !hitStop) {
        score = 1.0;
        console.log(`[Quant Evaluation] 🟢 WIN! Hit target of ${target.toFixed(2)}.`);
      } else if (hitStop) {
        score = 0.0;
        console.log(`[Quant Evaluation] 🔴 LOSS! Hit stop loss of ${stop.toFixed(2)}.`);
      } else {
        score = 0.5;
        console.log(`[Quant Evaluation] 🟡 OPEN. Has not hit target or stop yet. Max favorable excursion: ${(maxExcursion * 100).toFixed(2)}%`);
      }

      // 4. Save evaluation back to DynamoDB
      const evalItem: EvaluationItem = {
        pk: `EVALUATION#${pred.symbol}`,
        sk: `TIMESTAMP#${pred.createdAt}`,
        symbol: pred.symbol,
        predictionTimestamp: pred.createdAt,
        evaluatedAt,
        bias,
        score,
        hitStop,
        hitTarget,
        maxExcursion
      };

      await putItem(evalItem);
      console.log(`[Quant Evaluation] 💾 Saved evaluation for ${pred.symbol} to database.`);

      if (thesis.factors && Array.isArray(thesis.factors)) {
        for (const f of thesis.factors) {
          const fname = f.factorName;
          if (!factorStats[fname]) {
            factorStats[fname] = { tries: 0, wins: 0, losses: 0, score: 0 };
          }
          factorStats[fname].tries += 1;
          factorStats[fname].score += score;
          if (score === 1.0) factorStats[fname].wins += 1;
          if (score === 0.0) factorStats[fname].losses += 1;
        }
      }
    }

    factorStatsItem.updatedAt = new Date().toISOString();
    await putItem(factorStatsItem);
    console.log('[Quant Evaluation] 📈 Updated FACTOR_STATS with new performance data.');

    console.log('\n[Quant Evaluation] ✨ Evaluation cycle complete.');

  } catch (err) {
    console.error('[Quant Evaluation] ❌ Error during evaluation:', err);
  }
}

evaluateQuant();
