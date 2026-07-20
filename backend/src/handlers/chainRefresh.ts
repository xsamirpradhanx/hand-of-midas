// 1. Check if market is open
// 2. Query DynamoDB for all unique symbols across all users' watchlists
// 3. For each symbol (in parallel, max 5 concurrent): fetch chain, score, store snapshot, update baselines
// 4. Log summary
import { isMarketOpen } from '../services/tradingCalendar.js';
import { getOptionsChainYahoo as getOptionsChain } from '../services/yahoo.js';
import { scoreContract, storeChainSnapshot, updateBaseline, getBaseline } from '../services/unusualActivity.js';
import { scanItems } from '../services/dynamodb.js';
import type { WatchlistItem } from '../types.js';

export async function handler(event: unknown): Promise<void> {
  const open = await isMarketOpen();
  if (!open) {
    console.log('Market closed, skipping refresh');
    return;
  }

  try {
    // Note: scanItems needs to be implemented or mocked in dynamodb.js. Using a hypothetical signature here.
    // Query DynamoDB for all unique symbols across all users' watchlists
    // (scan for all items with sk beginning with 'WATCHLIST#', deduplicate symbols)
    const allItems = await scanItems<WatchlistItem>({
      FilterExpression: 'begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':prefix': 'WATCHLIST#',
      },
    });

    const uniqueSymbols = Array.from(new Set(allItems.map(item => item.symbol)));
    
    let refreshed = 0;
    let scored = 0;
    let unusual = 0;

    const concurrencyLimit = 5;
    
    for (let i = 0; i < uniqueSymbols.length; i += concurrencyLimit) {
      const batch = uniqueSymbols.slice(i, i + concurrencyLimit);
      
      await Promise.all(batch.map(async (symbol) => {
        try {
          const chain = await getOptionsChain(symbol);
          
          if (chain && chain.results) {
            const snapshotContracts: any[] = [];
            
            for (const contract of chain.results) {
              const baseline = await getBaseline(contract.ticker);
              const scoreResult = await scoreContract(contract, baseline);
              
              if (scoreResult.isUnusual) {
                unusual++;
              }
              
              scored++;
              snapshotContracts.push({ contract, score: scoreResult });
              
              await updateBaseline(contract.ticker, contract);
            }
            
            await storeChainSnapshot(symbol, snapshotContracts);
          }
          refreshed++;
        } catch (err) {
          console.error(`Error processing symbol ${symbol}:`, err);
        }
      }));
    }

    console.log(`Summary: ${refreshed} symbols refreshed, ${scored} contracts scored, ${unusual} unusual flags`);
  } catch (err) {
    console.error('Error during chain refresh:', err);
  }
}
