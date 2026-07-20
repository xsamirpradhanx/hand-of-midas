import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getOptionsChainYahoo } from '../services/yahoo.js';
import { getDTE } from '../services/tradingCalendar.js';

function jsonResponse(statusCode: number, body: any): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}

export async function getOptionsMetrics(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  const symbol = params['symbol']?.toUpperCase();
  if (!symbol) return jsonResponse(400, { error: 'Symbol required' });

  try {
    // Fetch all expirations
    const { expirations } = await getOptionsChainYahoo(symbol);
    if (!expirations || expirations.length === 0) {
      return jsonResponse(404, { error: 'No options data found' });
    }

    // Term Structure Data
    const termStructure: { expiry: string; dte: number; averageIV: number }[] = [];
    
    // GEX Aggregation (all expirations)
    const gexByStrike: Record<number, { callGex: number; putGex: number }> = {};
    
    // Max Pain (nearest expiration)
    const nearestExpiry = expirations[0];
    let maxPainData: { strike: number; intrinsicLoss: number }[] = [];
    let maxPainStrike = 0;

    // Skew Aggregation (all expirations)
    let totalCallVol = 0;
    let totalPutVol = 0;
    let totalCallOI = 0;
    let totalPutOI = 0;
    
    let spotPrice = 0;

    // Fetch the nearest 4 expirations to build a robust profile
    const activeExpirations = expirations.slice(0, 4);

    for (const expiry of activeExpirations) {
      const { contracts } = await getOptionsChainYahoo(symbol, expiry);
      const dte = await getDTE(expiry);

      let sumIV = 0;
      let countIV = 0;

      for (const c of contracts) {
        const strike = c.details.strike_price;
        const type = c.details.contract_type;
        const iv = c.implied_volatility || 0;
        const oi = c.day.open_interest || 0;
        const vol = c.day.volume || 0;
        
        // Accumulate for Term Structure
        if (iv > 0 && oi > 0) {
          sumIV += iv * oi;
          countIV += oi;
        }

        // Accumulate Skew
        if (type === 'call') {
          totalCallVol += vol;
          totalCallOI += oi;
        } else {
          totalPutVol += vol;
          totalPutOI += oi;
        }
      }

      if (countIV > 0) {
        termStructure.push({ expiry, dte, averageIV: sumIV / countIV });
      }
    }

    const { yf } = await import('../services/yahoo.js');
    const underlyingQuote = await yf.quote(symbol);
    spotPrice = underlyingQuote?.regularMarketPrice || 0;

    if (spotPrice > 0) {
      const { blackScholes } = await import('../services/greeks.js');

      for (const expiry of activeExpirations) {
        const { contracts } = await getOptionsChainYahoo(symbol, expiry);
        const dte = await getDTE(expiry);
        const t = Math.max(0.0027, dte / 365);

        for (const c of contracts) {
          const strike = c.details.strike_price;
          const type = c.details.contract_type as 'call' | 'put';
          const iv = c.implied_volatility || 0;
          const oi = c.day.open_interest || 0;

          if (oi === 0 || iv === 0) continue;

          const greeks = blackScholes(spotPrice, strike, t, 0.05, iv, type);
          const gamma = greeks.gamma;

          const gex = gamma * oi * 100 * spotPrice;

          if (!gexByStrike[strike]) gexByStrike[strike] = { callGex: 0, putGex: 0 };
          
          if (type === 'call') {
            gexByStrike[strike].callGex += gex;
          } else {
            gexByStrike[strike].putGex -= gex;
          }
        }
      }
    }

    // Calculate Max Pain for the nearest expiration
    if (spotPrice > 0) {
      const { contracts: nearestContracts } = await getOptionsChainYahoo(symbol, nearestExpiry);
      const strikes = Array.from(new Set(nearestContracts.map(c => c.details.strike_price))).sort((a, b) => a - b);
      
      for (const evalStrike of strikes) {
        let totalIntrinsicValue = 0;
        
        for (const c of nearestContracts) {
          const strike = c.details.strike_price;
          const type = c.details.contract_type;
          const oi = c.day.open_interest || 0;
          
          if (oi === 0) continue;

          let intrinsic = 0;
          if (type === 'call' && evalStrike > strike) {
            intrinsic = evalStrike - strike;
          } else if (type === 'put' && evalStrike < strike) {
            intrinsic = strike - evalStrike;
          }
          
          totalIntrinsicValue += intrinsic * oi * 100;
        }
        
        maxPainData.push({ strike: evalStrike, intrinsicLoss: totalIntrinsicValue });
      }

      if (maxPainData.length > 0) {
        maxPainData.sort((a, b) => a.intrinsicLoss - b.intrinsicLoss);
        maxPainStrike = maxPainData[0].strike;
      }
    }

    const gexProfile = Object.keys(gexByStrike).map(k => {
      const strike = parseFloat(k);
      const { callGex, putGex } = gexByStrike[strike];
      return { strike, callGex, putGex, totalGex: callGex + putGex };
    }).sort((a, b) => a.strike - b.strike);

    return jsonResponse(200, {
      symbol,
      spotPrice,
      maxPainStrike,
      maxPainExpiry: nearestExpiry,
      putCallSkew: {
        volumeRatio: totalCallVol > 0 ? totalPutVol / totalCallVol : 0,
        oiRatio: totalCallOI > 0 ? totalPutOI / totalCallOI : 0,
        totalCallVol,
        totalPutVol,
        totalCallOI,
        totalPutOI,
      },
      termStructure,
      gexProfile,
    });
  } catch (err: any) {
    console.error('Metrics Error:', err);
    return jsonResponse(500, { error: err.message });
  }
}
