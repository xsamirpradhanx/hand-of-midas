import { getItem, putItem, queryItems } from './dynamodb.js';
import type { DynamoDBBaseItem } from '../types.js';
import { getEarningsDate } from './polygon.js';

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
  /** @deprecated Use rawIV instead. Kept for backward-compat. */
  ivZScore: number;
  /** Raw implied volatility as a decimal (e.g. 1.12 = 112%). */
  rawIV: number;
  /** Change in IV vs prior trading day, in decimal points (e.g. 0.25 = +25pp). Null if no prior snapshot. */
  ivDelta: number | null;
  /** Underlying stock % change today (e.g. -0.10 = -10%). */
  stockChangePercent: number | null;
  /** True if next earnings date falls on or before this contract's expiry. */
  earningsBeforeExpiry: boolean;
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
// Whale scoring (shared by scanner + options chain)
// ---------------------------------------------------------------------------

export const WHALE_MIN_VOLUME = 250;          // Lowered from 500 — catches real flows on thinner names
export const WHALE_MIN_PREMIUM = 100_000;
// OI data lags 1 full day (updated overnight by exchanges). Using 3× against stale OI would reject
// most real intraday whale prints. 1.5× is industry standard and still highly anomalous.
export const WHALE_MIN_VOL_OI_RATIO = 1.5;

export function computeWhaleScore(input: {
  volume: number;
  openInterest: number;
  price: number;
  dte: number;
}): number | null {
  const { volume, openInterest, price, dte } = input;

  if (volume < WHALE_MIN_VOLUME) return null;

  const premium = volume * price * 100;
  if (premium < WHALE_MIN_PREMIUM) return null;

  const volumeOIRatio = openInterest > 0 ? volume / openInterest : volume;
  if (volumeOIRatio < WHALE_MIN_VOL_OI_RATIO) return null;

  const dteFactor = Math.max(1, dte);
  const oiFactor = Math.max(1, openInterest);

  return (volume / oiFactor) * Math.log10(Math.max(premium, 10)) * (30 / dteFactor);
}

export function buildWhaleFlagReasons(
  volume: number,
  openInterest: number,
  premium: number,
  dte: number,
  volumeOIRatio: number,
): string[] {
  const flagReasons: string[] = [];
  flagReasons.push(`Volume (${volume}) exceeds Open Interest (${openInterest}) by ${volumeOIRatio.toFixed(1)}x`);
  flagReasons.push(`Massive notional premium: $${Math.floor(premium).toLocaleString()}`);
  if (dte <= 14) flagReasons.push(`Aggressive short-dated positioning (${dte} DTE)`);
  return flagReasons;
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
  // NOTE: isSweep bonus removed — daily bar options data cannot detect multi-exchange sweeps.
  // The isSweep flag is reserved for future tick-level data integration.
  const compositeSigma = (0.4 * volumeZScore) + (0.3 * premiumZScore) + (0.2 * ivZScore) + (0.1 * oiBonus);

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
    ivZScore,          // backward-compat alias
    rawIV: contract.iv,
    ivDelta: null,     // caller populates after snapshot lookup
    stockChangePercent: null,
    earningsBeforeExpiry: false,
    isSweep: contract.isSweep,
    compositeSigma,
    flagReasons,
    contractTicker: contract.contractTicker,
  };
}

/**
 * Percentile-rank the compositeSigma scores within a scored set.
 * Returns scores in [0, 100] where 100 = highest anomaly in the session.
 * This makes cross-ticker comparison meaningful regardless of absolute score magnitude.
 */
export function percentileRankScores(anomalies: AnomalyScore[]): AnomalyScore[] {
  if (anomalies.length === 0) return anomalies;
  const sorted = [...anomalies].sort((a, b) => a.compositeSigma - b.compositeSigma);
  return anomalies.map(a => {
    const rank = sorted.findIndex(s => s === a);
    const percentile = ((rank + 1) / sorted.length) * 100;
    return { ...a, compositeSigma: Number(percentile.toFixed(1)) };
  });
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
  /** Underlying stock % change for the day, threaded in from the quote endpoint. */
  stockChangePercent?: number;
  provider?: string;
}): Promise<{ data: AnomalyScore[]; source: string }> {
  
  if (!filters.symbol) {
    return { data: [], source: 'yahoo' };
  }

  const { fetchOptionsChainProviderAware } = await import('./providerService.js');
  const { getDTE } = await import('./tradingCalendar.js');

  const symbol = filters.symbol;

  // 0. Prefetch earnings date and prior-day IV snapshot in parallel
  const todayDate = new Date().toISOString().split('T')[0]!;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayDate = yesterday.toISOString().split('T')[0]!;

  const [earningsDate, priorIVSnaps] = await Promise.all([
    getEarningsDate(symbol),
    queryItems<{ pk: string; sk: string; iv: number }>(  
      `IV_SNAP#${symbol}#${yesterdayDate}`,
    ),
  ]);

  // Build a lookup map: "strike#expiry#side" → prior IV
  const priorIVMap = new Map<string, number>();
  for (const snap of priorIVSnaps) {
    priorIVMap.set(snap.sk, snap.iv);
  }

  // 1. Fetch available expirations
  const { expirations, source } = await fetchOptionsChainProviderAware(symbol, undefined, filters.provider);
  if (expirations.length === 0) return { data: [], source };

  // 2. Scan nearest 6 expirations — institutions also build structured positions 60-90 days out.
  // Previously only 4 expirations, which missed LEAPS and 2-3 month positioning.
  const nearestExpirations = expirations.slice(0, 6);
  let anomalies: AnomalyScore[] = [];

  for (const expiry of nearestExpirations) {
    const { contracts } = await fetchOptionsChainProviderAware(filters.symbol, expiry, filters.provider);
    const dte = await getDTE(expiry);

    for (const c of contracts) {
      const vol = c.day.volume || 0;
      const oi = c.day.open_interest || 0;

      const bid = c.last_quote?.bid || 0;
      const ask = c.last_quote?.ask || 0;
      let referencePrice = 0;
      if (bid > 0 && ask > 0) {
        referencePrice = (bid + ask) / 2;
      } else {
        referencePrice = (c.last_quote?.last ?? 0) > 0 ? c.last_quote!.last : (bid || ask);
      }

      const whaleScore = computeWhaleScore({
        volume: vol,
        openInterest: oi,
        price: referencePrice,
        dte,
      });
      if (whaleScore == null) continue;

      const premium = vol * referencePrice * 100;
      const volumeOIRatio = oi > 0 ? vol / oi : vol;

      const flagReasons = buildWhaleFlagReasons(vol, oi, premium, dte, volumeOIRatio);

      // Trade-side estimation: if referencePrice is closer to ask → buyer-initiated (bullish aggression)
      // if closer to bid → seller-initiated (bearish aggression). Mid-price = ambiguous.
      // `bid` and `ask` are already declared above for the referencePrice calculation.
      let isBuyerInitiated: boolean | null = null;
      if (bid > 0 && ask > 0 && ask > bid) {
        const midpoint = (bid + ask) / 2;
        if (referencePrice >= midpoint + (ask - bid) * 0.15) isBuyerInitiated = true;  // paid near ask
        else if (referencePrice <= midpoint - (ask - bid) * 0.15) isBuyerInitiated = false; // hit bid
        // else: ambiguous mid-price trade
      }
      if (isBuyerInitiated === true) flagReasons.push('Buyer-initiated: premium paid near Ask (directional bullish aggression)');
      if (isBuyerInitiated === false) flagReasons.push('Seller-initiated: trade hit Bid (directional bearish aggression)');

      const contractIV = c.implied_volatility ?? 0;
      const side = c.details.contract_type as 'call' | 'put';
      const ivSnapKey = `${c.details.strike_price}#${expiry}#${side}`;
      const priorIV = priorIVMap.get(ivSnapKey) ?? null;
      const ivDelta = priorIV !== null ? contractIV - priorIV : null;

      // Flag significant IV spike (≥10pp = 0.10 in decimal)
      if (ivDelta !== null && ivDelta >= 0.10) {
        flagReasons.push(`IV spike: +${(ivDelta * 100).toFixed(1)}pp today (now ${(contractIV * 100).toFixed(1)}%)`);
      }

      // Earnings before expiry flag
      const earningsBeforeExpiry = earningsDate !== null && earningsDate <= expiry;
      if (earningsBeforeExpiry && earningsDate) {
        flagReasons.push(`Earnings ${earningsDate} before expiry — event-driven positioning`);
      }

      anomalies.push({
        symbol,
        strike: c.details.strike_price,
        expiry: expiry,
        dte,
        side,
        premium,
        volume: vol,
        openInterest: oi,
        volumeOIRatio,
        volumeZScore: volumeOIRatio,        // Vol/OI ratio proxy (true Z-scores need 20-day baseline)
        premiumZScore: Math.log10(premium), // log10 of notional (normalized size proxy)
        ivZScore: contractIV,               // backward-compat alias (raw IV)
        rawIV: contractIV,
        ivDelta,
        stockChangePercent: filters.stockChangePercent ?? null,
        earningsBeforeExpiry,
        isSweep: false,
        compositeSigma: whaleScore,
        flagReasons,
        contractTicker: c.ticker
      });
    }
  }

  // Percentile-rank scores within this session's anomaly set (0-100 where 100 = rarest)
  const ranked = percentileRankScores(anomalies);

  // Persist today's IV snapshot (non-blocking, best-effort)
  const ivSnapshotPk = `IV_SNAP#${symbol}#${todayDate}`;
  const ivTtl = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60; // 3-day TTL
  Promise.all(
    anomalies.map(a =>
      putItem({
        pk: ivSnapshotPk,
        sk: `${a.strike}#${a.expiry}#${a.side}`,
        iv: a.rawIV,
        ttl: ivTtl,
      }),
    ),
  ).catch(err => console.warn('IV snapshot write failed (non-fatal):', err));

  // Filter by user params — note: minSigma now compares against percentile rank (0-100)
  const minSigma = filters.minSigma ?? 50; // Default: top 50th percentile
  const minPremium = filters.minPremium ?? WHALE_MIN_PREMIUM;

  const filtered = ranked.filter(a => {
    if (a.compositeSigma < minSigma) return false;
    if (a.premium < minPremium) return false;
    if (filters.side && a.side !== filters.side) return false;
    if (filters.dteMax !== undefined && a.dte > filters.dteMax) return false;
    return true;
  });

  // Sort by highest percentile rank
  filtered.sort((a, b) => b.compositeSigma - a.compositeSigma);

  return { data: filtered.slice(0, 50), source }; // Return top 50
}
