import { yf } from './src/services/yahoo.js';

async function main() {
  const universe = ['TSLA', 'NVDA', 'AAPL', 'AMD', 'SPY', 'QQQ', 'MSTR'];
  const rawQuotes = await yf.quote(universe);
  for (const q of rawQuotes) {
    const symbol = q['symbol'];
    const pmVol = q['preMarketVolume'];
    const regVol = q['regularMarketVolume'];
    const pmChange = q['preMarketChangePercent'];
    const regChange = q['regularMarketChangePercent'];
    const state = q['marketState'];
    console.log(`${symbol}: state=${state}, pmVol=${pmVol}, pmChange=${pmChange}, regVol=${regVol}, regChange=${regChange}`);
  }
}
main().catch(console.error);
