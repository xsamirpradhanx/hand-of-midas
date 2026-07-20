import { scanItems, putItem } from '../services/dynamodb.js';
import { getOptionsChainYahoo } from '../services/yahoo.js';
import { getDTE } from '../services/tradingCalendar.js';
import { AlertItem } from '../routes/alerts.js';

interface WatchlistItem {
  pk: string;
  sk: string;
}

export async function runBackgroundWatcher() {
  console.log('Running background watcher...');
  
  try {
    // 1. Get all unique symbols from watchlists
    const watchlists = await scanItems<WatchlistItem>({
      FilterExpression: 'begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':prefix': 'WATCHLIST#',
      }
    });

    const symbols = new Set<string>();
    for (const item of watchlists) {
      const symbol = item.sk.replace('WATCHLIST#', '');
      symbols.add(symbol);
    }

    console.log(`Monitoring ${symbols.size} symbols...`);

    const todayDate = new Date().toISOString().slice(0, 10);
    const ttl = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // 7-day TTL

    // 2. Fetch metrics for each symbol and evaluate heuristics
    for (const symbol of symbols) {
      try {
        const { expirations } = await getOptionsChainYahoo(symbol);
        if (!expirations || expirations.length === 0) continue;
        
        // Save OI snapshot for all near expirations (up to 4)
        const snapshotPk = `OI_SNAPSHOT#${symbol}#${todayDate}`;
        const activeExpirations = expirations.slice(0, 4);
        
        for (const expiry of activeExpirations) {
          const { contracts } = await getOptionsChainYahoo(symbol, expiry);
          
          let totalCallVol = 0;
          let totalPutVol = 0;
          
          for (const c of contracts) {
            const vol = c.day.volume || 0;
            const oi = c.day.open_interest || 0;
            const type = c.details.contract_type;
            const strike = c.details.strike_price;
            const premium = vol * strike * 100; // rough premium approximation
            
            if (type === 'call') totalCallVol += vol;
            else totalPutVol += vol;
            
            // Save OI snapshot
            if (oi > 0) {
              await putItem({
                pk: snapshotPk,
                sk: `${strike}#${expiry}#${type}`,
                oi,
                ttl,
              }).catch(err => console.error(`Failed to save OI snapshot for ${symbol}`, err));
            }

            // Whale detection logic
            if (vol > 0 && oi > 0 && vol > oi * 3 && premium > 100000) {
              await createAlert(symbol, `Whale flow detected: ${vol} contracts traded on ${expiry} $${strike} ${type.toUpperCase()}`, 'high');
            }
          }
          
          // Skew detection logic (only for nearest expiry for alerts)
          if (expiry === expirations[0] && totalCallVol > 0 && totalPutVol > 0) {
            const volumeRatio = totalPutVol / totalCallVol;
            if (volumeRatio > 2.5) {
              await createAlert(symbol, `Extreme bearish flow: Put volume is ${volumeRatio.toFixed(1)}x Call volume`, 'medium');
            } else if (volumeRatio < 0.4) {
               await createAlert(symbol, `Extreme bullish flow: Call volume dominates Puts by ${(1/volumeRatio).toFixed(1)}x`, 'medium');
            }
          }
        }

      } catch (err) {
         console.error(`Failed to process watcher for ${symbol}`, err);
      }
    }
  } catch (err) {
    console.error('Background watcher failed:', err);
  }
}

async function createAlert(symbol: string, message: string, severity: 'high' | 'medium') {
  const timestamp = new Date().toISOString();
  const alert: AlertItem = {
    pk: 'GLOBAL_ALERTS',
    sk: `ALERT#${timestamp}#${symbol}#${Math.random().toString(36).substr(2, 5)}`,
    symbol,
    message,
    timestamp,
    severity
  };
  await putItem(alert);
  console.log(`Alert created: [${symbol}] ${message}`);
}
