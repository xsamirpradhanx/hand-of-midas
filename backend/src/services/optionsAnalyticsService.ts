import { fetchOptionsChainProviderAware, getQuoteProviderAware } from './providerService.js';
import type { PolygonOptionsContract } from './polygon.js';
import { blackScholes , getRiskFreeRate } from './greeks.js';
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
  state: 'backwardation' | 'contango' | 'flat' | 'kinked';
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
  source: string;
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

  return blackScholes(spot, strike, timeToExpiryYears, getRiskFreeRate(), iv, type).delta;
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

function classifyTermStructure(points: TermStructurePoint[]): {
  state: TermStructureResult['state'];
  atrBoundMultiplier: number;
  narrative: string;
} {
  const nearIV = points[0]!.averageIV;
  const farIV = points[points.length - 1]!.averageIV;
  const slopeRatio = nearIV / farIV;

  if (points.length >= 3) {
    let isIncreasing = false;
    let isDecreasing = false;
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1].averageIV;
      const curr = points[i].averageIV;
      if (curr > prev * 1.01) isIncreasing = true;
      if (curr < prev * 0.99) isDecreasing = true;
    }
    if (isIncreasing && isDecreasing) {
      return {
        state: 'kinked',
        atrBoundMultiplier: 1.2,
        narrative: `Term structure is kinked or inverted (near ${(nearIV * 100).toFixed(1)}%, far ${(farIV * 100).toFixed(1)}%), likely pricing in specific event risk in the near term.`,
      };
    }
  }

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
  const classification = classifyTermStructure(points);

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
    const { contracts } = await fetchOptionsChainProviderAware(symbol, expiry);
    const avgIV = oiWeightedAvgIV(contracts);
    if (avgIV <= 0) continue;

    const dte = await getDTE(expiry);
    points.push({ expiry, dte, averageIV: avgIV });
  }

  if (points.length < 2) return null;

  const nearIV = points[0]!.averageIV;
  const farIV = points[points.length - 1]!.averageIV;
  const slopeRatio = nearIV / farIV;
  const classification = classifyTermStructure(points);

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

  // Standard 25-delta risk-reversal convention: RR = call IV − put IV.
  // Positive = calls bid over puts (upside demand, bullish skew); negative = the
  // usual equity put skew. This was previously computed as (put − call), so the
  // number carried the opposite sign to the words next to it — a chain with calls
  // bid by 3.9pp printed "call IV exceeds put IV by 3.9pp ... skew -3.91pp".
  // The narratives were right; the figure was inverted against convention.
  const skew = (callIV - putIV) * 100;

  const putDelta = contractDelta(put, spot, timeToExpiryYears);
  const callDelta = contractDelta(call, spot, timeToExpiryYears);

  let bias: RiskReversalSkewResult['bias'] = 'neutral';
  if (skew < -3) bias = 'bearish';
  else if (skew > 3) bias = 'bullish';

  const narrative =
    skew < -3
      ? `25Δ put IV exceeds call IV by ${Math.abs(skew).toFixed(1)}pp (RR ${skew.toFixed(1)}pp) — institutional crash protection demand skews Sell Zone lower.`
      : skew > 3
        ? `25Δ call IV exceeds put IV by ${skew.toFixed(1)}pp (RR +${skew.toFixed(1)}pp) — upside demand dominates skew.`
        : `25Δ risk reversal near flat (RR ${skew >= 0 ? '+' : ''}${skew.toFixed(1)}pp) — balanced volatility skew.`;

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

/**
 * Compute Gamma Exposure (GEX) profile across strikes, aggregated across multiple expirations.
 * NOTE: This is an OI-based proxy. It assumes dealers are long calls and short puts.
 * Open interest does not definitively reveal customer vs. dealer positioning, so 
 * "net gamma" and "gamma flip" are assumptions, not measured facts.
 *
 * Multi-expiry weighting: each expiry is weighted by 1/DTE so near-term gamma
 * dominates (as it should — near-expiry gamma is ~10x larger per dollar of OI).
 * The gamma flip price is interpolated linearly between the two bracketing strikes.
 */
function computeGexProfile(
  contracts: PolygonOptionsContract[],
  spot: number,
  expirations: string[],
): GexSummary | null {
  const gexByStrike: Record<number, number> = {};

  // Nearest 6 expirations to avoid O(N²) BSM calls for very long chains
  const targetExpiries = new Set(expirations.slice(0, 6));

  for (const c of contracts) {
    const expiry = c.details.expiration_date;
    if (!targetExpiries.has(expiry)) continue;

    const strike = c.details.strike_price;
    const type = c.details.contract_type;
    const oi = c.day.open_interest || 0;
    const iv = c.implied_volatility || 0;
    if (oi === 0 || iv === 0 || strike <= 0) continue;

    // T_eff guard: clamp to 1 calendar day minimum to prevent 0-DTE gamma explosion
    const rawT = getTimeToExpiryYears(expiry);
    const t = Math.max(rawT, 1 / 365);

    // Inverse-DTE weight: nearer expiries have proportionally larger gamma contribution
    const dte = Math.max(1, t * 365);
    const dteWeight = 1 / dte;

    const { gamma } = blackScholes(spot, strike, t, getRiskFreeRate(), iv, type);
    const gex = gamma * oi * 100 * spot * spot * 0.01 * dteWeight;
    const signed = type === 'call' ? gex : -gex;
    gexByStrike[strike] = (gexByStrike[strike] || 0) + signed;
  }

  const strikes = Object.keys(gexByStrike).map(Number).sort((a, b) => a - b);
  if (strikes.length === 0) return null;

  const profile = strikes.map(strike => ({ strike, totalGex: gexByStrike[strike]! }));
  const netGamma = profile.reduce((sum, p) => sum + p.totalGex, 0);

  const isNetPositive = netGamma >= 0;
  const sortedProfile = [...profile].sort((a, b) => isNetPositive ? a.strike - b.strike : b.strike - a.strike);

  // Interpolated gamma-flip price: linear zero-crossing of cumulative GEX.
  // Every crossing is collected rather than breaking at the first one — deep-OTM
  // strikes with thin OI make cumulative GEX wobble across the axis, so the first
  // crossing is routinely numerical noise far from anything tradeable. A crossing
  // must be material relative to total |GEX|, and of the survivors we take the one
  // nearest spot. Consistent with dealerHedging.ts.
  const totalAbsGex = profile.reduce((sum, p) => sum + Math.abs(p.totalGex), 0);
  const GAMMA_FLIP_MATERIALITY = 0.02; // crossing must involve >=2% of total |GEX| to count
  const gammaFlipCandidates: number[] = [];
  let cumulative = 0;
  for (let i = 0; i < sortedProfile.length; i++) {
    const prev = cumulative;
    cumulative += sortedProfile[i]!.totalGex;

    if (i > 0 && prev !== 0 && Math.sign(prev) !== Math.sign(cumulative)) {
      const swing = Math.max(Math.abs(prev), Math.abs(cumulative));
      if (totalAbsGex > 0 && swing / totalAbsGex < GAMMA_FLIP_MATERIALITY) continue;
      const strikeA = sortedProfile[i - 1]!.strike;
      const strikeB = sortedProfile[i]!.strike;
      // Linear zero-crossing interpolation: x0 + (x1-x0) * |prev| / (|prev| + |curr|)
      gammaFlipCandidates.push(
        strikeA + (strikeB - strikeA) * Math.abs(prev) / (Math.abs(prev) + Math.abs(cumulative)),
      );
    }
  }

  const gammaFlipStrike = gammaFlipCandidates.length === 0
    ? 0
    : gammaFlipCandidates.reduce((best, k) =>
        Math.abs(k - spot) < Math.abs(best - spot) ? k : best);

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
  options?: { includeVix?: boolean; expiry?: string; provider?: string },
): Promise<OptionsAnalyticsResult> {
  const sym = symbol.toUpperCase();
  const includeVix = options?.includeVix !== false;
  const provider = options?.provider;

  const [quoteRes, chainRes] = await Promise.all([
    getQuoteProviderAware(sym, provider),
    fetchOptionsChainProviderAware(sym, undefined, provider),
  ]);

  const spotPrice = quoteRes.data.price;
  const { expirations, contracts, source } = chainRes;

  const targetExpiry =
    options?.expiry && expirations.includes(options.expiry)
      ? options.expiry
      : expirations[0];

  let riskReversal: RiskReversalSkewResult | null = null;
  let gex: GexSummary | null = null;

  if (targetExpiry && spotPrice > 0) {
    const dte = await getDTE(targetExpiry);
    riskReversal = computeRiskReversalFromContracts(contracts, spotPrice, targetExpiry, dte);

    // Multi-expiry GEX: pass full contracts array and all expirations; function handles slicing to nearest 6
    gex = computeGexProfile(contracts, spotPrice, expirations);
  }

  const termStructure = await buildTermStructure(sym, expirations, contracts);

  let vixTermStructure: TermStructureResult | null = null;
  if (includeVix && sym !== 'VIX') {
    try {
      const vixChain = await fetchOptionsChainProviderAware('VIX', undefined, provider);
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
    source,
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
