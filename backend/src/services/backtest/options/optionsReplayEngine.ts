import { blackScholes, getRiskFreeRate } from '../../greeks.js';
import type { OptionsBacktestStrategy, OptionsDataSource, OptionsDecisionContext, OptionsBacktestPlan } from './types.js';

interface ActiveOptionsTrade {
  plan: OptionsBacktestPlan;
  entryDate: string;
  daysHeld: number;
}

export interface OptionsReplayOptions {
  warmupBars?: number;
}

export interface OptionsReplayResult {
  totalTrades: number;
  wins: number;
  losses: number;
  expectancyR: number;
  totalR: number;
  trades: any[];
}

export async function runOptionsReplay(
  symbol: string,
  dataSource: OptionsDataSource,
  strategy: OptionsBacktestStrategy,
  options: OptionsReplayOptions = {}
): Promise<OptionsReplayResult> {
  const warmup = options.warmupBars ?? 50;
  const bars = await dataSource.bars(symbol);
  
  if (bars.length < warmup) {
    return { totalTrades: 0, wins: 0, losses: 0, expectancyR: 0, totalR: 0, trades: [] };
  }

  let activeTrade: ActiveOptionsTrade | null = null;
  const closedTrades: any[] = [];
  
  let totalR = 0;
  let wins = 0;
  let losses = 0;

  for (let i = warmup; i < bars.length; i++) {
    const currentBar = bars[i]!;
    const dateStr = currentBar.datetime.split('T')[0]!;
    
    // 1. Grade existing trade if active
    if (activeTrade) {
      activeTrade.daysHeld++;
      
      const chain = await dataSource.historicalChain(symbol, dateStr);
      let currentPremium = 0;
      
      const targetStrike = activeTrade.plan.selectedContract.details.strike_price;
      const targetType = activeTrade.plan.selectedContract.details.contract_type;
      
      // Attempt to find real premium from chain
      const realContract = chain?.contracts.find(c => 
        c.details.strike_price === targetStrike && 
        c.details.contract_type === targetType &&
        c.details.expiration_date === activeTrade!.plan.selectedContract.details.expiration_date
      );

      if (realContract && realContract.last_quote?.last) {
        currentPremium = realContract.last_quote.last;
      } else {
        // Fallback to Black-Scholes simulation
        const expirationDate = new Date(activeTrade.plan.selectedContract.details.expiration_date);
        const currentDate = new Date(dateStr);
        const dte = Math.max(0, (expirationDate.getTime() - currentDate.getTime()) / (1000 * 60 * 60 * 24));
        const T = dte / 365;
        
        // Assume IV stays constant from entry if we can't observe it
        const iv = activeTrade.plan.selectedContract.implied_volatility || 0.3;
        const greeks = blackScholes(currentBar.close, targetStrike, T, getRiskFreeRate(), iv, targetType);
        currentPremium = greeks.price;
      }

      // Check Stop / Target / Expiration
      const expirationStr = activeTrade.plan.selectedContract.details.expiration_date;
      const isExpired = dateStr >= expirationStr;
      
      const hitTarget = currentPremium >= activeTrade.plan.targetPremium;
      const hitStop = currentPremium <= activeTrade.plan.stopPremium;
      
      if (hitTarget || hitStop || isExpired) {
        // Close trade
        const pnlPremium = currentPremium - activeTrade.plan.entryPremium;
        const riskPremium = activeTrade.plan.entryPremium - activeTrade.plan.stopPremium;
        const rMulti = riskPremium > 0 ? (pnlPremium / riskPremium) : 0;
        
        totalR += rMulti;
        if (rMulti > 0) wins++;
        else losses++;

        closedTrades.push({
          entryDate: activeTrade.entryDate,
          exitDate: dateStr,
          bias: activeTrade.plan.bias,
          contract: `${expirationStr} ${targetStrike}${targetType.toUpperCase()[0]}`,
          entryPremium: activeTrade.plan.entryPremium,
          exitPremium: currentPremium,
          realizedR: rMulti,
          reason: isExpired ? 'EXPIRATION' : (hitTarget ? 'TARGET' : 'STOP')
        });

        activeTrade = null;
      }
    }

    // 2. Look for new trade (only if flat, for simplicity in this engine)
    if (!activeTrade) {
      const context: OptionsDecisionContext = {
        symbol,
        bars: bars.slice(0, i + 1),
        currentChain: await dataSource.historicalChain(symbol, dateStr)
      };

      const plan = strategy.decide(context);
      if (plan) {
        activeTrade = { plan, entryDate: dateStr, daysHeld: 0 };
      }
    }
  }

  return {
    totalTrades: closedTrades.length,
    wins,
    losses,
    expectancyR: closedTrades.length > 0 ? totalR / closedTrades.length : 0,
    totalR,
    trades: closedTrades
  };
}
