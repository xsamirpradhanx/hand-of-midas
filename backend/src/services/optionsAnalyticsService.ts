import { fetchOptionsChainWithFallback } from './optionsFallback.js';
import { getQuote } from './polygon.js';
import type { PolygonOptionsContract } from './polygon.js';
import { blackScholes } from './greeks.js';
import { getDTE, getTimeToExpiryYears } from './tradingCalendar.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RiskReversalSkewResult {
  expiry: string;
  putStrike: number;
  callStrike: number;
  putDelta: number;
  callDelta: number;
  putIV: number;
  callIV: number;
  /** Put IV minus Call IV, in percentage points (e.g. +4.2 = put IV 4.2pp above call). */
  skew: number;
  bias: 'bearish' | 'bullish' | 'neutral';
  narrative: string;
}

export interface TermStructurePoint {
  expiry: string;
  dte: number;
  averageIV: number;
}

export interface TermStructureResult {
  points: TermStructurePoint[];
  nearIV: number;
  farIV: number;
  slopeRatio: number;
  state: 'backwardation' | 'contango' | 'flat';
  /** Multiplier applied to ATR bounds in the prediction engine (widens during panic). */
  atrBoundMultiplier: number;
  narrative: string;
}

export interface GexSummary {
  netGamma: number;
  gammaFlipStrike: number;
  maxAbsGexStrike: number;
  profile: { strike: number; totalGex: number }[];
}

export interface OptionsAnalyticsResult {
  symbol: string;
  spotPrice: number;
  asOf: string;
  riskReversal: RiskReversalSkewResult | null;
  termStructure: TermStructureResult | null;
  gex: GexSummary | null;
  vixTermStructure: TermStructureResult | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TARGET_CALL_DELTA = 0.25;
const TARGET_PUT_DELTA = -0.25;
const BACKWARDATION_THRESHOLD = 1.08;
const CONTANGO_THRESHOLD = 0.95;

function contractDelta(
  contract: PolygonOptionsContract,
  spot: number,
  timeToExpiryYears: number,
): number {
  if (contract.greeks?.delta && Math.abs(contract.greeks.delta) > 0.01) {
    return contract.greeks.delta;
  }

  const strike = contract.details.strike_price;
  const type = contract.details.contract_type;
  const iv = contract.implied_volatility || 0;
  if (strike <= 0 || iv <= 0 || timeToExpiryYears <= 0) return 0;

  return blackScholes(spot, strike, timeToExpiryYears, 0.05, iv, type).delta;
}

function isLiquid(contract: PolygonOptionsContract): boolean {
  const iv = contract.implied_volatility || 0;
  const oi = contract.day?.open_interest || 0;
  const bid = contract.last_quote?.bid || 0;
  const ask = contract.last_quote?.ask || 0;
  // Relaxed constraints for smaller cap stocks (like WULF)
  // Options might have wide spreads or 0 bids, but if there's OI and IV, it's usable.
  const spread = ask > bid && ask > 0 ? (ask - bid) / ask : 1;
  return iv > 0 && oi > 0 && (bid > 0 || oi > 10) && spread < 0.85;
}

function find25DeltaContracts(
  contracts: PolygonOptionsContract[],
  spot: number,
  timeToExpiryYears: number,
): { put: PolygonOptionsContract | null; call: PolygonOptionsContract | null } {
  let bestPut: PolygonOptionsContract | null = null;
  let bestCall: PolygonOptionsContract | null = null;
  let minPutDiff = Infinity;
  let minCallDiff = Infinity;

  for (const c of contracts) {
    if (!isLiquid(c)) continue;

    const delta = contractDelta(c, spot, timeToExpiryYears);
    const type = c.details.contract_type;

    if (type === 'put' && delta < 0 && delta > -0.45) {
      const diff = Math.abs(delta - TARGET_PUT_DELTA);
      if (diff < minPutDiff) {
        minPutDiff = diff;
        bestPut = c;
      }
    } else if (type === 'call' && delta > 0 && delta < 0.45) {
      const diff = Math.abs(delta - TARGET_CALL_DELTA);
      if (diff < minCallDiff) {
        minCallDiff = diff;
        bestCall = c;
      }
    }
  }

  return { put: bestPut, call: bestCall };
}

function oiWeightedAvgIV(contracts: PolygonOptionsContract[]): number {
  let sum = 0;
  let weight = 0;

  for (const c of contracts) {
    if (!isLiquid(c)) continue;
    const iv = c.implied_volatility!;
    const oi = c.day.open_interest;
    sum += iv * oi;
    weight += oi;
  }

  return weight > 0 ? sum / weight : 0;
}

function classifyTermStructure(nearIV: number, farIV: number): {
  state: TermStructureResult['state'];
  atrBoundMultiplier: number;
  narrative: string;
} {
  const slopeRatio = nearIV / farIV;

  if (slopeRatio > BACKWARDATION_THRESHOLD) {
    return {
      state: 'backwardation',
      atrBoundMultiplier: 1.35,
      narrative: `Near-term IV (${(nearIV * 100).toFixed(1)}%) exceeds far-term (${(farIV * 100).toFixed(1)}%) — volatility backwardation signals short-term panic. ATR bounds widened.`,
    };
  }

  if (slopeRatio < CONTANGO_THRESHOLD) {
    return {
      state: 'contango',
      atrBoundMultiplier: 1.0,
      narrative: `Far-term IV (${(farIV * 100).toFixed(1)}%) exceeds near-term (${(nearIV * 100).toFixed(1)}%) — contango confirms orderly risk pricing.`,
    };
  }

  return {
    state: 'flat',
    atrBoundMultiplier: 1.1,
    narrative: `Near and far IV are aligned (ratio ${slopeRatio.toFixed(2)}) — neutral term structure.`,
  };
}

async function buildTermStructureFromChain(
  expirations: string[],
  allContracts: PolygonOptionsContract[],
  maxPoints = 4,
): Promise<TermStructureResult | null> {
  const slice = expirations.slice(0, maxPoints);
  if (slice.length < 2) return null;

  const points: TermStructurePoint[] = [];

  for (const expiry of slice) {
    const contracts = allContracts.filter(c => c.details.expiration_date === expiry);
    const avgIV = oiWeightedAvgIV(contracts);
    if (avgIV <= 0) continue;

    const dte = await getDTE(expiry);
    points.push({ expiry, dte, averageIV: avgIV });
  }

  if (points.length < 2) return null;

  const nearIV = points[0]!.averageIV;
  const farIV = points[points.length - 1]!.averageIV;
  const slopeRatio = nearIV / farIV;
  const classification = classifyTermStructure(nearIV, farIV);

  return {
    points,
    nearIV,
    farIV,
    slopeRatio,
    ...classification,
  };
}

async function buildTermStructure(
  symbol: string,
  expirations: string[],
  existingContracts?: PolygonOptionsContract[],
  maxPoints = 4,
): Promise<TermStructureResult | null> {
  if (existingContracts && existingContracts.length > 0) {
    return buildTermStructureFromChain(expirations, existingContracts, maxPoints);
  }

  const slice = expirations.slice(0, maxPoints);
  if (slice.length < 2) return null;

  const points: TermStructurePoint[] = [];

  for (const expiry of slice) {
    const { contracts } = await fetchOptionsChainWithFallback(symbol, expiry);
    const avgIV = oiWeightedAvgIV(contracts);
    if (avgIV <= 0) continue;

    const dte = await getDTE(expiry);
    points.push({ expiry, dte, averageIV: avgIV });
  }

  if (points.length < 2) return null;

  const nearIV = points[0]!.averageIV;
  const farIV = points[points.length - 1]!.averageIV;
  const slopeRatio = nearIV / farIV;
  const classification = classifyTermStructure(nearIV, farIV);

  return {
    points,
    nearIV,
    farIV,
    slopeRatio,
    ...classification,
  };
}

function computeRiskReversalFromContracts(
  contracts: PolygonOptionsContract[],
  spot: number,
  expiry: string,
  dte: number,
): RiskReversalSkewResult | null {
  const nearestContracts = contracts.filter(c => c.details.expiration_date === expiry);
  const t = Math.max(1 / 365, getTimeToExpiryYears(expiry));
  const { put, call } = find25DeltaContracts(nearestContracts, spot, t);
  if (!put || !call) return null;
  return computeRiskReversal(put, call, spot, expiry, t);
}

function computeRiskReversal(
  put: PolygonOptionsContract,
  call: PolygonOptionsContract,
  spot: number,
  expiry: string,
  timeToExpiryYears: number,
): RiskReversalSkewResult {
  const putIV = put.implied_volatility!;
  const callIV = call.implied_volatility!;
  const skew = (putIV - callIV) * 100;

  const putDelta = contractDelta(put, spot, timeToExpiryYears);
  const callDelta = contractDelta(call, spot, timeToExpiryYears);

  let bias: RiskReversalSkewResult['bias'] = 'neutral';
  if (skew > 3) bias = 'bearish';
  else if (skew < -3) bias = 'bullish';

  const narrative =
    skew > 3
      ? `25Δ put IV exceeds call IV by ${skew.toFixed(1)}pp — institutional crash protection demand skews Sell Zone lower.`
      : skew < -3
        ? `25Δ call IV exceeds put IV by ${Math.abs(skew).toFixed(1)}pp — upside demand dominates skew.`
        : `25Δ risk reversal near flat (${skew >= 0 ? '+' : ''}${skew.toFixed(1)}pp) — balanced volatility skew.`;

  return {
    expiry,
    putStrike: put.details.strike_price,
    callStrike: call.details.strike_price,
    putDelta,
    callDelta,
    putIV,
    callIV,
    skew,
    bias,
    narrative,
  };
}

function computeGexProfile(
  contracts: PolygonOptionsContract[],
  spot: number,
  timeToExpiryYears: number,
): GexSummary | null {
  const gexByStrike: Record<number, number> = {};

  for (const c of contracts) {
    const strike = c.details.strike_price;
    const type = c.details.contract_type;
    const oi = c.day.open_interest || 0;
    const iv = c.implied_volatility || 0;
    if (oi === 0 || iv === 0 || strike <= 0) continue;

    const { gamma } = blackScholes(spot, strike, timeToExpiryYears, 0.05, iv, type);
    const gex = gamma * oi * 100 * spot * spot * 0.01;
    const signed = type === 'call' ? gex : -gex;
    gexByStrike[strike] = (gexByStrike[strike] || 0) + signed;
  }

  const strikes = Object.keys(gexByStrike).map(Number).sort((a, b) => a - b);
  if (strikes.length === 0) return null;

  const profile = strikes.map(strike => ({ strike, totalGex: gexByStrike[strike]! }));
  const netGamma = profile.reduce((sum, p) => sum + p.totalGex, 0);

  let gammaFlipStrike = strikes[0]!;
  let cumulative = 0;
  const desc = [...profile].sort((a, b) => b.strike - a.strike);
  for (let i = 0; i < desc.length; i++) {
    const prev = cumulative;
    cumulative += desc[i]!.totalGex;
    if (i > 0 && prev !== 0 && Math.sign(prev) !== Math.sign(cumulative)) {
      gammaFlipStrike = desc[i]!.strike;
      break;
    }
  }

  const maxAbsGexStrike = profile.reduce(
    (best, p) => (Math.abs(p.totalGex) > Math.abs(best.totalGex) ? p : best),
    profile[0]!,
  ).strike;

  return { netGamma, gammaFlipStrike, maxAbsGexStrike, profile };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute institutional options analytics for a symbol:
 * 25Δ risk-reversal skew, IV term structure, and dealer GEX profile.
 */
export async function getOptionsAnalytics(
  symbol: string,
  options?: { includeVix?: boolean; expiry?: string },
): Promise<OptionsAnalyticsResult> {
  const sym = symbol.toUpperCase();
  const includeVix = options?.includeVix !== false;

  const [quote, chain] = await Promise.all([
    getQuote(sym),
    fetchOptionsChainWithFallback(sym),
  ]);

  const spotPrice = quote.price;
  const { expirations, contracts } = chain;

  const targetExpiry =
    options?.expiry && expirations.includes(options.expiry)
      ? options.expiry
      : expirations[0];

  let riskReversal: RiskReversalSkewResult | null = null;
  let gex: GexSummary | null = null;

  if (targetExpiry && spotPrice > 0) {
    const dte = await getDTE(targetExpiry);
    riskReversal = computeRiskReversalFromContracts(contracts, spotPrice, targetExpiry, dte);

    const nearestContracts = contracts.filter(
      c => c.details.expiration_date === targetExpiry,
    );
    const t = Math.max(1 / 365, getTimeToExpiryYears(targetExpiry));
    gex = computeGexProfile(nearestContracts, spotPrice, t);
  }

  const termStructure = await buildTermStructure(sym, expirations, contracts);

  let vixTermStructure: TermStructureResult | null = null;
  if (includeVix && sym !== 'VIX') {
    try {
      const vixChain = await fetchOptionsChainWithFallback('VIX');
      vixTermStructure = await buildTermStructure('VIX', vixChain.expirations);
    } catch {
      // VIX chain may be unavailable on some data tiers — non-fatal.
    }
  }

  return {
    symbol: sym,
    spotPrice,
    asOf: new Date().toISOString(),
    riskReversal,
    termStructure,
    gex,
    vixTermStructure,
  };
}

/** Evaluate 25Δ risk reversal from an in-memory options chain (for predictive factors). */
export async function evaluateRiskReversalFactor(
  contracts: PolygonOptionsContract[],
  expirations: string[],
  currentPrice: number,
): Promise<RiskReversalSkewResult | null> {
  const expiry = expirations[0];
  if (!expiry) return null;
  const dte = await getDTE(expiry);
  return computeRiskReversalFromContracts(contracts, currentPrice, expiry, dte);
}

/** Evaluate IV term structure from an in-memory options chain (for predictive factors). */
export async function evaluateTermStructureFactor(
  contracts: PolygonOptionsContract[],
  expirations: string[],
): Promise<TermStructureResult | null> {
  return buildTermStructureFromChain(expirations, contracts);
}
