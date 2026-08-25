import 'dotenv/config';
import { runOptionsReplay } from '../services/backtest/options/optionsReplayEngine.js';
import { FileBarDataSource, cachedSymbols, DEFAULT_CACHE_DIR } from '../services/backtest/barCache.js';
import { loadOptionsChain, type OptionsChainRecord } from '../services/marketData/optionsStore.js';
import type { OptionsDataSource, OptionsDecisionContext, OptionsBacktestPlan, OptionsBacktestStrategy } from '../services/backtest/options/types.js';

class CombinedOptionsDataSource implements OptionsDataSource {
  private equitySource: FileBarDataSource;

  constructor(symbols?: string[], from?: string, to?: string) {
    this.equitySource = new FileBarDataSource({ symbols, from, to });
  }

  async symbols(): Promise<string[]> {
    return this.equitySource.symbols();
  }

  async bars(symbol: string) {
    return this.equitySource.bars(symbol);
  }

  async historicalChain(symbol: string, dateStr: string): Promise<OptionsChainRecord | null> {
    return loadOptionsChain(symbol, dateStr);
  }
}

// A stub strategy for testing the harness
class DummyOptionsStrategy implements OptionsBacktestStrategy {
  decide(context: OptionsDecisionContext): OptionsBacktestPlan | undefined {
    // Only trade if we have a chain (we only have today's data right now)
    if (!context.currentChain || context.currentChain.contracts.length === 0) return undefined;
    
    // Pick the first call contract as a dummy test
    const callContracts = context.currentChain.contracts.filter(c => c.details.contract_type === 'call');
    if (callContracts.length === 0) return undefined;
    
    const contract = callContracts[Math.floor(callContracts.length / 2)]!; // pick one in the middle
    const entry = contract.last_quote?.ask || 1.0;
    
    return {
      bias: 'LONG',
      selectedContract: contract,
      entryPremium: entry,
      stopPremium: entry * 0.5, // 50% stop loss
      targetPremium: entry * 2.0, // 100% gain target
      expectedHoldDays: 5,
    };
  }
}

async function main() {
  console.log('Running Options Backtest Harness...');
  console.log('NOTE: Currently uses .options_history/ which only has data gathered by captureOptions.ts.');
  
  const from = process.env['FROM'];
  const to = process.env['TO'];
  const syms = process.env['SYMS'] ? process.env['SYMS'].split(',') : undefined;

  const dataSource = new CombinedOptionsDataSource(syms, from, to);
  const strategy = new DummyOptionsStrategy();
  
  const symbols = await dataSource.symbols();
  console.log(`Replaying ${symbols.length} symbols...`);

  let totalTrades = 0;
  let totalWins = 0;
  let totalR = 0;

  for (const sym of symbols) {
    const result = await runOptionsReplay(sym, dataSource, strategy, { warmupBars: 50 });
    totalTrades += result.totalTrades;
    totalWins += result.wins;
    totalR += result.totalR;
    
    if (result.totalTrades > 0) {
      console.log(`${sym}: ${result.totalTrades} trades, win rate: ${(result.wins / result.totalTrades * 100).toFixed(1)}%, expectancy: ${(result.totalR / result.totalTrades).toFixed(2)}R`);
    }
  }

  console.log(`\n=== OPTIONS BACKTEST COMPLETE ===`);
  console.log(`Total Trades: ${totalTrades}`);
  if (totalTrades > 0) {
    console.log(`Overall Win Rate: ${(totalWins / totalTrades * 100).toFixed(1)}%`);
    console.log(`Overall Expectancy: ${(totalR / totalTrades).toFixed(2)}R per trade`);
  } else {
    console.log('No trades generated. (Ensure historical options data exists for the replay period).');
  }
}

main().catch(console.error);
