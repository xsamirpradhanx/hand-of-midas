import { listStoredSymbols } from '../services/backtest/dynamoDataSource.js';
import { fetchOptionsChainWithFallback } from '../services/optionsFallback.js';
import { saveOptionsChain } from '../services/marketData/optionsStore.js';

async function main() {
  console.log('Fetching universe for options capture...');
  const symbols = await listStoredSymbols('1day');
  console.log(`Found ${symbols.length} symbols in the universe.`);

  const dateStr = new Date().toISOString();
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    try {
      console.log(`[${i + 1}/${symbols.length}] Fetching options for ${sym}...`);
      const chain = await fetchOptionsChainWithFallback(sym);
      
      await saveOptionsChain({
        symbol: sym,
        asOf: dateStr,
        expirations: chain.expirations,
        contracts: chain.contracts,
        quote: chain.quote,
        source: chain.source
      });
      successCount++;
    } catch (err: any) {
      console.error(`Failed to capture options for ${sym}:`, err.message);
      failCount++;
    }

    // Small backoff to avoid rate limits on Polygon / Yahoo
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\nOptions capture complete. Success: ${successCount}, Failed: ${failCount}`);
}

main().catch(console.error);
