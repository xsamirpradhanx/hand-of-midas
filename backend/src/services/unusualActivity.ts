import { getItem, putItem, queryItems } from './dynamodb.js';
import type { DynamoDBBaseItem } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContractBaseline extends DynamoDBBaseItem {
  symbol: string;
  strike: number;
  expiry: string;
  side: 'call' | 'put';
  avgVolume: number;
  stdVolume: number;
  avgPremium: number;
  stdPremium: number;
  avgIV: number;
  stdIV: number;
  sampleCount: number;
  lastUpdated: string;
  ttl: number;
}

export interface AnomalyScore {
  symbol: string;
  strike: number;
  expiry: string;
  dte: number;
  side: 'call' | 'put';
  premium: number;
  volume: number;
  openInterest: number;
  volumeOIRatio: number;
  volumeZScore: number;
  premiumZScore: number;
  ivZScore: number;
  isSweep: boolean;
  compositeSigma: number;
  flagReasons: string[];
  contractTicker: string;
}

interface SnapshotItem extends DynamoDBBaseItem {
  contracts: AnomalyScore[];
  ttl: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load baseline from DynamoDB, return null if not found.
 */
export async function getBaseline(symbol: string, strike: number, expiry: string, side: 'call' | 'put'): Promise<ContractBaseline | null> {
  const pk = `BASELINE#${symbol.toUpperCase()}`;
  const sk = `${strike}#${expiry}#${side}`;
  const item = await getItem<ContractBaseline>(pk, sk);
  return item ?? null;
}

/**
 * Update baseline using exponential moving average (alpha=2/(N+1) where N=20).
 */
export async function updateBaseline(contract: { symbol: string; strike: number; expiry: string; side: 'call' | 'put'; volume: number; premium: number; iv: number }): Promise<void> {
  const pk = `BASELINE#${contract.symbol.toUpperCase()}`;
  const sk = `${contract.strike}#${contract.expiry}#${contract.side}`;
  
  let baseline = await getBaseline(contract.symbol, contract.strike, contract.expiry, contract.side);
  
  const nowStr = new Date().toISOString();
  // TTL = 45 days
  const ttl = Math.floor(Date.now() / 1000) + 45 * 24 * 60 * 60;

  if (!baseline) {
    baseline = {
      pk,
      sk,
      symbol: contract.symbol,
      strike: contract.strike,
      expiry: contract.expiry,
      side: contract.side,
      avgVolume: contract.volume,
      stdVolume: contract.volume * 0.1, // Initial pseudo-stddev
      avgPremium: contract.premium,
      stdPremium: contract.premium * 0.1,
      avgIV: contract.iv,
      stdIV: contract.iv * 0.05,
      sampleCount: 1,
      lastUpdated: nowStr,
      ttl,
    };
  } else {
    const N = 20;
    const alpha = 2 / (N + 1);
    
    // EMA updates
    const diffVol = contract.volume - baseline.avgVolume;
    baseline.avgVolume += alpha * diffVol;
    baseline.stdVolume = Math.sqrt((1 - alpha) * (baseline.stdVolume * baseline.stdVolume + alpha * diffVol * diffVol));
    
    const diffPrem = contract.premium - baseline.avgPremium;
    baseline.avgPremium += alpha * diffPrem;
    baseline.stdPremium = Math.sqrt((1 - alpha) * (baseline.stdPremium * baseline.stdPremium + alpha * diffPrem * diffPrem));

    const diffIV = contract.iv - baseline.avgIV;
    baseline.avgIV += alpha * diffIV;
    baseline.stdIV = Math.sqrt((1 - alpha) * (baseline.stdIV * baseline.stdIV + alpha * diffIV * diffIV));
    
    baseline.sampleCount += 1;
    baseline.lastUpdated = nowStr;
    baseline.ttl = ttl;
  }
  
  await putItem(baseline);
}

/**
 * Score a single contract against its baseline.
 */
export function scoreContract(contract: {
  symbol: string; strike: number; expiry: string; dte: number; side: 'call' | 'put';
  volume: number; openInterest: number; premium: number; iv: number;
  isSweep: boolean; contractTicker: string;
}, baseline: ContractBaseline | null): AnomalyScore {

  const volumeOIRatio = contract.openInterest > 0 ? contract.volume / contract.openInterest : contract.volume;
  
  let volumeZScore = 0;
  let premiumZScore = 0;
  let ivZScore = 0;
  
  if (baseline && baseline.sampleCount > 3) {
    if (baseline.stdVolume > 0) volumeZScore = (contract.volume - baseline.avgVolume) / baseline.stdVolume;
    if (baseline.stdPremium > 0) premiumZScore = (contract.premium - baseline.avgPremium) / baseline.stdPremium;
    if (baseline.stdIV > 0) ivZScore = (contract.iv - baseline.avgIV) / baseline.stdIV;
  } else {
    // Structural proxy if no baseline
    volumeZScore = volumeOIRatio > 2 ? Math.min(volumeOIRatio, 5) : 0;
  }

  // Cap negative Z-scores for composite calculation (we only care about positive anomalies)
  volumeZScore = Math.max(0, volumeZScore);
  premiumZScore = Math.max(0, premiumZScore);
  ivZScore = Math.max(0, ivZScore);

  const oiBonus = volumeOIRatio > 1.5 ? 2.0 : 0;
  const compositeSigma = (0.4 * volumeZScore) + (0.3 * premiumZScore) + (0.2 * ivZScore) + (0.1 * oiBonus) + (contract.isSweep ? 1.0 : 0);

  const flagReasons: string[] = [];
  if (volumeZScore > 2.0) flagReasons.push(`Volume is ${volumeZScore.toFixed(1)}σ above 20-day average`);
  if (premiumZScore > 2.0) flagReasons.push(`Premium is ${premiumZScore.toFixed(1)}σ above 20-day average`);
  if (ivZScore > 2.0) flagReasons.push(`IV is ${ivZScore.toFixed(1)}σ above 20-day average`);
  if (volumeOIRatio > 1.5) flagReasons.push(`Volume exceeds Open Interest by ${(volumeOIRatio).toFixed(1)}x`);
  if (contract.isSweep) flagReasons.push(`Multiple sweep orders detected`);

  return {
    symbol: contract.symbol,
    strike: contract.strike,
    expiry: contract.expiry,
    dte: contract.dte,
    side: contract.side,
    premium: contract.premium,
    volume: contract.volume,
    openInterest: contract.openInterest,
    volumeOIRatio,
    volumeZScore,
    premiumZScore,
    ivZScore,
    isSweep: contract.isSweep,
    compositeSigma,
    flagReasons,
    contractTicker: contract.contractTicker,
  };
}

/**
 * Get all flagged unusual activity (Whale Flows).
 */
export async function getUnusualActivity(filters: {
  symbol?: string;
  minSigma?: number;
  minPremium?: number;
  side?: 'call' | 'put';
  dteMax?: number;
}): Promise<AnomalyScore[]> {
  
  if (!filters.symbol) {
    return [];
  }

  const { getOptionsChainYahoo } = await import('./yahoo.js');
  const { getDTE } = await import('./tradingCalendar.js');
  
  // 1. Fetch available expirations
  const { expirations } = await getOptionsChainYahoo(filters.symbol);
  if (expirations.length === 0) return [];

  // 2. We only scan the nearest 4 expirations to save time and because whale flows are short-dated
  const nearestExpirations = expirations.slice(0, 4);
  let anomalies: AnomalyScore[] = [];

  for (const expiry of nearestExpirations) {
    const { contracts } = await getOptionsChainYahoo(filters.symbol, expiry);
    const dte = await getDTE(expiry);

    for (const c of contracts) {
      const vol = c.day.volume || 0;
      const oi = c.day.open_interest || 0;
      
      // Basic filters to avoid noise
      if (vol < 500) continue; // Needs to be size
      
      const bid = c.last_quote.bid || 0;
      const ask = c.last_quote.ask || 0;
      const mid = (bid + ask) / 2;
      const premium = vol * mid * 100;
      
      if (premium < (filters.minPremium || 100000)) continue; // Must be over $100k notional

      const volumeOIRatio = oi > 0 ? vol / oi : vol;
      if (volumeOIRatio < 3.0) continue; // Volume must be at least 3x Open Interest

      // Calculate Whale Score
      // Formula: (Vol / max(OI, 1)) * log10(Premium) * (1 / max(DTE, 1))
      // Adding moneyness factor (optional but good for out-of-the-money conviction)
      const dteFactor = Math.max(1, dte);
      const oiFactor = Math.max(1, oi);
      
      let whaleScore = (vol / oiFactor) * Math.log10(Math.max(premium, 10)) * (30 / dteFactor);

      const flagReasons: string[] = [];
      flagReasons.push(`Volume (${vol}) exceeds Open Interest (${oi}) by ${volumeOIRatio.toFixed(1)}x`);
      flagReasons.push(`Massive notional premium: $${Math.floor(premium).toLocaleString()}`);
      if (dte <= 14) flagReasons.push(`Aggressive short-dated positioning (${dte} DTE)`);

      anomalies.push({
        symbol: filters.symbol,
        strike: c.details.strike_price,
        expiry: expiry,
        dte,
        side: c.details.contract_type as 'call' | 'put',
        premium,
        volume: vol,
        openInterest: oi,
        volumeOIRatio,
        volumeZScore: volumeOIRatio, // Reuse field for simplicity
        premiumZScore: Math.log10(premium),
        ivZScore: c.implied_volatility, 
        isSweep: false, // We can't know this from snapshot
        compositeSigma: whaleScore,
        flagReasons,
        contractTicker: c.ticker
      });
    }
  }

  // Filter by user params
  const filtered = anomalies.filter(a => {
    if (filters.side && a.side !== filters.side) return false;
    if (filters.dteMax !== undefined && a.dte > filters.dteMax) return false;
    return true;
  });

  // Sort by highest Whale Score
  filtered.sort((a, b) => b.compositeSigma - a.compositeSigma);

  return filtered.slice(0, 50); // Return top 50
}
