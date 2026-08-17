import { getRiskFreeRate } from '../services/greeks.js';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { fetchOptionsChainProviderAware } from '../services/providerService.js';
import { getDTE, getTimeToExpiryYears } from '../services/tradingCalendar.js';
import { getItem, putItem, queryItems } from '../services/dynamodb.js';
import { jsonResponse } from '../utils/response.js';

interface VolumeOIByStrike {
  strike: number;
  callVol: number;
  callOI: number;
  putVol: number;
  putOI: number;
  callVolOI: number;
  putVolOI: number;
  totalVolOI: number;
}

interface OIChange {
  strike: number;
  expiry: string;
  side: 'call' | 'put';
  currentOI: number;
  previousOI: number;
  oiChange: number;
  oiChangePct: number;
}

export async function getOptionsMetrics(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  const symbol = params['symbol']?.toUpperCase();
  console.log('getOptionsMetrics called for', symbol, 'query=', event.queryStringParameters);
  if (!symbol) return jsonResponse(400, { error: 'Symbol required' });

  try {
    const providerHeader = event.headers?.['x-data-provider']?.toLowerCase();
    
    // Fetch all expirations
    const { expirations, quote, source } = await fetchOptionsChainProviderAware(symbol, undefined, providerHeader);
    if (!expirations || expirations.length === 0) {
      return jsonResponse(404, { error: 'No options data found' });
    }

    let spotPrice = quote?.regularMarketPrice || 0;
    
    const responseHeaders = {
      'X-Source-Provider': source
    };

    // Term Structure Data
    const termStructure: { expiry: string; dte: number; averageIV: number }[] = [];
    
    const targetExpiry = event.queryStringParameters?.expiry;
    
    // GEX Aggregation (all expirations)
    const gexByStrike: Record<number, { callGex: number; putGex: number }> = {};
    
    // Volume/OI Aggregation (all expirations)
    const volOIByStrike: Record<number, { callVol: number; callOI: number; putVol: number; putOI: number }> = {};
    
    // OI snapshot for day-over-day comparison
    const currentOIMap: { strike: number; expiry: string; side: 'call' | 'put'; oi: number }[] = [];
    
    // Max Pain (nearest expiration or target)
    const activeMaxPainExpiry = targetExpiry && expirations.includes(targetExpiry) ? targetExpiry : expirations[0];
    let maxPainData: { strike: number; intrinsicLoss: number }[] = [];
    let maxPainStrike = 0;

    // Skew Aggregation (all expirations)
    let totalCallVol = 0;
    let totalPutVol = 0;
    let totalCallOI = 0;
    let totalPutOI = 0;
    
    let straddleExpectedMove = 0;
    let straddleExpectedMovePct = 0;

    // Fetch the nearest 4 expirations to build a robust profile for Term Structure
    const tsExpirations = expirations.slice(0, 4);
    
    // For specific metrics (GEX, Skew, Vol/OI), use target expiry if provided, else use all 4
    const metricsExpirations = targetExpiry && expirations.includes(targetExpiry) 
      ? [targetExpiry] 
      : tsExpirations;

    // Build Term Structure
    for (const expiry of tsExpirations) {
      const { contracts } = await fetchOptionsChainProviderAware(symbol, expiry, providerHeader);
      const dte = getDTE(expiry);

      let sumIV = 0;
      let countIV = 0;

      for (const c of contracts) {
        const iv = c.implied_volatility || 0;
        const oi = c.day.open_interest || 0;
        const volume = c.day.volume || 0;
        const bid = c.last_quote?.bid || 0;
        const ask = c.last_quote?.ask || 0;
        const spread = ask > bid ? (ask - bid) / ask : 1;
        
        // Exclude completely illiquid or wildly wide-spread options
        if (iv > 0 && oi > 0 && bid > 0 && spread < 0.5) {
          sumIV += iv * oi;
          countIV += oi;
        }
      }

      if (countIV > 0) {
        termStructure.push({ expiry, dte, averageIV: sumIV / countIV });
      }
    }

    // Build Specific Metrics (GEX, Skew, Vol/OI)
    for (const expiry of metricsExpirations) {
      const { contracts } = await fetchOptionsChainProviderAware(symbol, expiry, providerHeader);
      
      for (const c of contracts) {
        const strike = c.details.strike_price;
        const type = c.details.contract_type;
        const oi = c.day.open_interest || 0;
        const vol = c.day.volume || 0;
        
        // Accumulate Skew
        if (type === 'call') {
          totalCallVol += vol;
          totalCallOI += oi;
        } else {
          totalPutVol += vol;
          totalPutOI += oi;
        }

        // Accumulate Volume/OI by Strike
        if (!volOIByStrike[strike]) volOIByStrike[strike] = { callVol: 0, callOI: 0, putVol: 0, putOI: 0 };
        if (type === 'call') {
          volOIByStrike[strike].callVol += vol;
          volOIByStrike[strike].callOI += oi;
        } else {
          volOIByStrike[strike].putVol += vol;
          volOIByStrike[strike].putOI += oi;
        }

        // Track current OI for snapshot
        if (oi > 0) {
          currentOIMap.push({ strike, expiry, side: type as 'call' | 'put', oi });
        }
      }
    }

    if (spotPrice > 0) {
      const { blackScholes } = await import('../services/greeks.js');

      for (const expiry of metricsExpirations) {
        const { contracts } = await fetchOptionsChainProviderAware(symbol, expiry, providerHeader);
        // Use calendar DTE for GEX weighting (consistent with dealerHedging.ts and
        // optionsAnalyticsService.ts). Trading-day DTE (getDTE) is NOT used here.
        const rawT = getTimeToExpiryYears(expiry);
        const t = Math.max(rawT, 1 / 365);
        // 1/DTE weight: near-expiry options have larger gamma impact per $ of spot move.
        // Without this, a 0DTE and a 30DTE option contribute equal GEX — incorrect.
        const calDte = Math.max(1, t * 365);
        const dteWeight = 1 / calDte;

        for (const c of contracts) {
          const strike = c.details.strike_price;
          const type = c.details.contract_type as 'call' | 'put';
          const iv = c.implied_volatility || 0;
          const oi = c.day.open_interest || 0;

          if (oi === 0 || iv === 0) continue;

          const greeks = blackScholes(spotPrice, strike, t, getRiskFreeRate(), iv, type);
          const gamma = greeks.gamma;

          // Dollar Gamma per 1% move, DTE-weighted for cross-expiry consistency.
          const gex = gamma * oi * 100 * spotPrice * spotPrice * 0.01 * dteWeight;

          if (!gexByStrike[strike]) gexByStrike[strike] = { callGex: 0, putGex: 0 };

          if (type === 'call') {
            gexByStrike[strike].callGex += gex;
          } else {
            gexByStrike[strike].putGex -= gex;
          }
        }
      }
    }

    // Calculate Max Pain for the target expiration
    if (spotPrice > 0) {
      const { contracts: nearestContracts } = await fetchOptionsChainProviderAware(symbol, activeMaxPainExpiry, providerHeader);
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
        
        // Calculate Straddle Expected Move based on closest strike to Spot (ATM)
        let atmStrike = strikes.reduce((prev, curr) => Math.abs(curr - spotPrice) < Math.abs(prev - spotPrice) ? curr : prev);
        let callPrice = 0;
        let putPrice = 0;
        
        for (const c of nearestContracts) {
          if (c.details.strike_price === atmStrike) {
            const price = c.last_quote?.last || c.last_quote?.ask || 0;
            if (c.details.contract_type === 'call') callPrice = price;
            if (c.details.contract_type === 'put') putPrice = price;
          }
        }
        
        straddleExpectedMove = callPrice + putPrice;
        straddleExpectedMovePct = straddleExpectedMove / spotPrice;
      }
    }

    const gexProfile = Object.keys(gexByStrike).map(k => {
      const strike = parseFloat(k);
      const { callGex, putGex } = gexByStrike[strike];
      return { strike, callGex, putGex, totalGex: callGex + putGex };
    }).sort((a, b) => a.strike - b.strike);

    const totalNetGex = gexProfile.reduce((sum, p) => sum + p.totalGex, 0);
    const gexProfileSorted = [...gexProfile].sort((a, b) => a.strike - b.strike);

    // Gamma flip: linear interpolation at the zero-crossing of cumulative GEX.
    // Every crossing is collected rather than breaking at the first one. Cumulative
    // GEX starts near zero and wobbles across the axis over deep-OTM strikes that
    // carry almost no open interest, so the first crossing is routinely numerical
    // noise far from anything tradeable. Two filters make the result meaningful:
    // a crossing must be material relative to the book's total gamma, and of the
    // survivors we take the one nearest spot. Consistent with dealerHedging.ts.
    const totalAbsGex = gexProfileSorted.reduce((sum, p) => sum + Math.abs(p.totalGex), 0);
    const GAMMA_FLIP_MATERIALITY = 0.02; // crossing must involve >=2% of total |GEX| to count
    const gammaFlipCandidates: number[] = [];
    let cumulativeGex = 0;
    for (let i = 0; i < gexProfileSorted.length; i++) {
      const prev = cumulativeGex;
      cumulativeGex += gexProfileSorted[i].totalGex;

      if (i > 0 && Math.sign(prev) !== Math.sign(cumulativeGex) && prev !== 0) {
        const swing = Math.max(Math.abs(prev), Math.abs(cumulativeGex));
        if (totalAbsGex > 0 && swing / totalAbsGex < GAMMA_FLIP_MATERIALITY) continue;
        const strikeA = gexProfileSorted[i - 1].strike;
        const strikeB = gexProfileSorted[i].strike;
        gammaFlipCandidates.push(
          strikeA + (strikeB - strikeA) * Math.abs(prev) / (Math.abs(prev) + Math.abs(cumulativeGex)),
        );
      }
    }

    const gammaFlipStrike = gammaFlipCandidates.length === 0
      ? 0
      : gammaFlipCandidates.reduce((best, k) =>
          Math.abs(k - spotPrice) < Math.abs(best - spotPrice) ? k : best);

    // No fallback here: if cumulative GEX never crosses zero within the scanned
    // strikes (or no crossing clears the materiality bar), gammaFlipStrike stays 0
    // ("no reliable flip level found"), matching optionsAnalyticsService.ts and
    // what the frontend already renders as "None" rather than fabricating a strike.

    // Build Volume/OI profile
    const volumeOIProfile: VolumeOIByStrike[] = Object.keys(volOIByStrike).map(k => {
      const strike = parseFloat(k);
      const { callVol, callOI, putVol, putOI } = volOIByStrike[strike];
      const callVolOI = callOI > 0 ? callVol / callOI : 0;
      const putVolOI = putOI > 0 ? putVol / putOI : 0;
      const totalOI = callOI + putOI;
      const totalVol = callVol + putVol;
      const totalVolOI = totalOI > 0 ? totalVol / totalOI : 0;
      return { strike, callVol, callOI, putVol, putOI, callVolOI, putVolOI, totalVolOI };
    }).sort((a, b) => a.strike - b.strike);

    // OI Change Day-over-Day
    const today = new Date();
    const todayDate = today.toISOString().slice(0, 10);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayDate = yesterday.toISOString().slice(0, 10);

    let oiChanges: OIChange[] = [];

    const previousSnapshots = await queryItems<{
      pk: string;
      sk: string;
      oi: number;
      ttl?: number;
    }>(`OI_SNAPSHOT#${symbol}#${yesterdayDate}`);

    if (previousSnapshots.length > 0) {
      const prevMap = new Map<string, number>();
      for (const snap of previousSnapshots) {
        prevMap.set(snap.sk, snap.oi);
      }

      for (const entry of currentOIMap) {
        const sk = `${entry.strike}#${entry.expiry}#${entry.side}`;
        const previousOI = prevMap.get(sk) ?? 0;
        const change = entry.oi - previousOI;
        if (Math.abs(change) > 0) {
          oiChanges.push({
            strike: entry.strike,
            expiry: entry.expiry,
            side: entry.side,
            currentOI: entry.oi,
            previousOI,
            oiChange: change,
            oiChangePct: previousOI > 0 ? change / previousOI : 0,
          });
        }
      }

      oiChanges.sort((a, b) => Math.abs(b.oiChange) - Math.abs(a.oiChange));
      oiChanges = oiChanges.slice(0, 20);
    }

    // Save today's OI snapshot (non-blocking)
    const ttl = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // 7-day TTL
    const snapshotPk = `OI_SNAPSHOT#${symbol}#${todayDate}`;
    Promise.all(
      currentOIMap.map(entry =>
        putItem({
          pk: snapshotPk,
          sk: `${entry.strike}#${entry.expiry}#${entry.side}`,
          oi: entry.oi,
          ttl,
        }),
      ),
    ).catch(console.error);

    return jsonResponse(200, {
      symbol,
      spotPrice,
      maxPainStrike,
      gammaFlipStrike,
      maxPainExpiry: activeMaxPainExpiry,
      receivedExpiry: event.queryStringParameters?.expiry ?? null,
      straddleExpectedMove,
      straddleExpectedMovePct,
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
      volumeOIByStrike: volumeOIProfile,
      oiChanges,
    }, responseHeaders);
  } catch (err: any) {
    console.error('Metrics Error:', err);
    return jsonResponse(500, { error: err.message });
  }
}
