import { fetchOptionsChainProviderAware, getQuoteProviderAware } from './providerService.js';
import type { PolygonOptionsContract } from './polygon.js';
import { blackScholes, getRiskFreeRate, impliedVolatility } from './greeks.js';
import { getDTE, getTimeToExpiryYears, getCalendarDTE } from './tradingCalendar.js';

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

/**
 * Real IV when the feed reports one, otherwise solved from the EOD close via
 * Black-Scholes inversion.
 *
 * Added for the ThetaData-backfilled S3 chains (FREE tier — no greeks, no IV,
 * no open interest, only close/volume), which previously made every function
 * below unconditionally dead: `contractDelta` fell back to `iv=0` -> delta 0,
 * `isLiquid` required `iv>0`, and `computeRiskReversal` read
 * `implied_volatility!` straight off the contract. Solving from price is not
 * a proxy for real IV, it *is* the real IV the market printed that close at —
 * `impliedVolatility()` already exists in greeks.ts and is already used this
 * way for the live options routes, just not for factors or backfilled data.
 */
/**
 * Drops same-day (0 DTE) expirations before anything picks a "near" point —
 * but only when `asOf` is set, i.e. only for the solved-IV backtest/audit
 * path. Confirmed empirically: SPY/QQQ have daily expirations, so the
 * nearest expiry is 0 DTE on almost every session, and by end-of-day an ATM
 * contract expiring at that same close has already decayed to near-intrinsic
 * value — solving IV from that price returns a numerically degenerate
 * (implausibly low, e.g. 1-4% against 12-15% realized vol on the same day)
 * read regardless of true market conditions. Real intraday quotes at 0 DTE
 * (the live path, `asOf` omitted) don't have this problem — a live bid/ask
 * reflects genuine remaining hours, not an EOD close on the settlement bar —
 * so live behavior is deliberately left unfiltered.
 */
export function excludeZeroDte(expirations: string[], asOf?: Date): string[] {
  if (!asOf) return expirations;
  return expirations.filter(e => getCalendarDTE(e, asOf) >= 1);
}

export function resolveContractIv(contract: PolygonOptionsContract, spot: number, asOf?: Date): number {
  const reported = contract.implied_volatility;
  if (reported && reported > 0) return reported;

  const close = contract.day?.close;
  const strike = contract.details?.strike_price;
  const expiry = contract.details?.expiration_date;
  const type = contract.details?.contract_type;
  if (!close || close <= 0 || !strike || strike <= 0 || !expiry || !type || spot <= 0) return 0;

  // getTimeToExpiryYears/getDTE measure against real "now" unless told
  // otherwise (see tradingCalendar.ts) — asOf must be the decision date this
  // contract is being evaluated at, or every historical expiry reads as
  // already-past and floors to a ~1-day time-to-expiry regardless of the
  // option's true remaining life at that point in history.
  const t = Math.max(getTimeToExpiryYears(expiry, asOf), 1 / 365);
  const solved = impliedVolatility(close, spot, strike, t, getRiskFreeRate(), type);
  return solved && solved > 0 ? solved : 0;
}

function contractDelta(
  contract: PolygonOptionsContract,
  spot: number,
  timeToExpiryYears: number,
  asOf?: Date,
): number {
  if (contract.greeks?.delta && Math.abs(contract.greeks.delta) > 0.01) {
    return contract.greeks.delta;
  }

  const strike = contract.details.strike_price;
  const type = contract.details.contract_type;
  const iv = resolveContractIv(contract, spot, asOf);
  if (strike <= 0 || iv <= 0 || timeToExpiryYears <= 0) return 0;

  return blackScholes(spot, strike, timeToExpiryYears, getRiskFreeRate(), iv, type).delta;
}

/**
 * `open_interest` being `undefined` (field not reported by this feed, see
 * PolygonOptionsContract.day) is treated differently from a reported `0` (no
 * open interest, a real liquidity signal). When OI is unreported we fall back
 * to volume as the liquidity read rather than failing closed on every contract.
 */
function isLiquid(contract: PolygonOptionsContract, spot: number, asOf?: Date): boolean {
  const iv = resolveContractIv(contract, spot, asOf);
  const oi = contract.day?.open_interest;
  const volume = contract.day?.volume || 0;
  const bid = contract.last_quote?.bid || 0;
  const ask = contract.last_quote?.ask || 0;
  const spread = ask > bid && ask > 0 ? (ask - bid) / ask : 1;

  if (iv <= 0) return false;
  if (oi !== undefined) {
    // Relaxed constraints for smaller cap stocks (like WULF)
    // Options might have wide spreads or 0 bids, but if there's OI and IV, it's usable.
    return oi > 0 && (bid > 0 || oi > 10) && spread < 0.85;
  }
  // No OI signal available at all — fall back to today's traded volume.
  return volume > 0;
}

function find25DeltaContracts(
  contracts: PolygonOptionsContract[],
  spot: number,
  timeToExpiryYears: number,
  asOf?: Date,
): { put: PolygonOptionsContract | null; call: PolygonOptionsContract | null } {
  let bestPut: PolygonOptionsContract | null = null;
  let bestCall: PolygonOptionsContract | null = null;
  let minPutDiff = Infinity;
  let minCallDiff = Infinity;

  for (const c of contracts) {
    if (!isLiquid(c, spot, asOf)) continue;

    const delta = contractDelta(c, spot, timeToExpiryYears, asOf);
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

/**
 * Weighted-average IV across a set of contracts (one expiry's worth). Weights
 * by open interest when the feed reports it (a real measure of standing
 * size); when it doesn't (see `isLiquid`), weights by volume instead — a
 * different thing (today's flow, not accumulated position) but the only
 * signal actually available, and better than an unweighted average across
 * strikes of wildly different liquidity.
 */
function oiWeightedAvgIV(contracts: PolygonOptionsContract[], spot: number, asOf?: Date): number {
  let sum = 0;
  let weight = 0;

  for (const c of contracts) {
    if (!isLiquid(c, spot, asOf)) continue;
    const iv = resolveContractIv(c, spot, asOf);
    const w = c.day.open_interest ?? c.day.volume ?? 0;
    sum += iv * w;
    weight += w;
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
  spot: number,
  asOf?: Date,
  maxPoints = 4,
): Promise<TermStructureResult | null> {
  const slice = expirations.slice(0, maxPoints);
  if (slice.length < 2) return null;

  const points: TermStructurePoint[] = [];

  for (const expiry of slice) {
    const contracts = allContracts.filter(c => c.details.expiration_date === expiry);
    const avgIV = oiWeightedAvgIV(contracts, spot, asOf);
    if (avgIV <= 0) continue;

    const dte = await getDTE(expiry, asOf);
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
  rawExpirations: string[],
  spot: number,
  asOf?: Date,
  existingContracts?: PolygonOptionsContract[],
  maxPoints = 4,
): Promise<TermStructureResult | null> {
  const expirations = excludeZeroDte(rawExpirations, asOf);
  if (existingContracts && existingContracts.length > 0) {
    // A chain snapshot typically advertises every expiration but only carries
    // contracts for the FRONT one (observed: NVDA returned 20 expirations and
    // 193 contracts, all 2026-08-21). Term structure needs at least two points,
    // so that snapshot always produced null — and because this returned
    // unconditionally, the per-expiry fetch below was unreachable whenever a
    // caller passed contracts. Both call sites did, so the whole factor was
    // dead. Treat the snapshot as an optimisation and fall through when it is
    // not enough rather than failing outright.
    const fromChain = await buildTermStructureFromChain(expirations, existingContracts, spot, asOf, maxPoints);
    if (fromChain) return fromChain;
  }

  const slice = expirations.slice(0, maxPoints);
  if (slice.length < 2) return null;

  const points: TermStructurePoint[] = [];

  for (const expiry of slice) {
    const { contracts } = await fetchOptionsChainProviderAware(symbol, expiry);
    const avgIV = oiWeightedAvgIV(contracts, spot, asOf);
    if (avgIV <= 0) continue;

    const dte = await getDTE(expiry, asOf);
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
  asOf?: Date,
): RiskReversalSkewResult | null {
  const nearestContracts = contracts.filter(c => c.details.expiration_date === expiry);
  const t = Math.max(1 / 365, getTimeToExpiryYears(expiry, asOf));
  const { put, call } = find25DeltaContracts(nearestContracts, spot, t, asOf);
  if (!put || !call) return null;
  return computeRiskReversal(put, call, spot, expiry, t, asOf);
}

function computeRiskReversal(
  put: PolygonOptionsContract,
  call: PolygonOptionsContract,
  spot: number,
  expiry: string,
  timeToExpiryYears: number,
  asOf?: Date,
): RiskReversalSkewResult {
  // find25DeltaContracts only returns contracts that passed isLiquid(), which
  // guarantees resolveContractIv() > 0 — but that may be a SOLVED iv, not the raw
  // field, so reading `implied_volatility` directly here would silently go
  // back to undefined/NaN for exactly the contracts this was meant to unblock.
  const putIV = resolveContractIv(put, spot, asOf);
  const callIV = resolveContractIv(call, spot, asOf);

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
  asOf?: Date,
): GexSummary | null {
  const gexByStrike: Record<number, number> = {};

  // Nearest 6 expirations to avoid O(N²) BSM calls for very long chains
  const targetExpiries = new Set(expirations.slice(0, 6));

  for (const c of contracts) {
    const expiry = c.details.expiration_date;
    if (!targetExpiries.has(expiry)) continue;

    const strike = c.details.strike_price;
    const type = c.details.contract_type;
    // GEX fundamentally needs real open interest — it measures standing
    // dealer position size, which volume (today's trades) cannot substitute
    // for. Unlike isLiquid()/oiWeightedAvgIV() above, there is no fallback
    // here on purpose: a volume-weighted number would not be gamma exposure,
    // it would be a different, unlabelled thing.
    const oi = c.day.open_interest || 0;
    const iv = resolveContractIv(c, spot, asOf);
    if (oi === 0 || iv === 0 || strike <= 0) continue;

    // T_eff guard: clamp to 1 calendar day minimum to prevent 0-DTE gamma explosion
    const rawT = getTimeToExpiryYears(expiry, asOf);
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

  // Live route: no asOf, defaults to real "now" — unchanged from before.
  const termStructure = await buildTermStructure(sym, expirations, spotPrice, undefined, contracts);

  let vixTermStructure: TermStructureResult | null = null;
  if (includeVix && sym !== 'VIX') {
    try {
      const vixChain = await fetchOptionsChainProviderAware('VIX', undefined, provider);
      // No VIX spot quote fetched here, so pass 0 — resolveContractIv() no-ops on a
      // non-positive spot, which keeps this call's behavior exactly as it was
      // (real reported IV only, no solve-from-price fallback) rather than
      // guessing a VIX level.
      vixTermStructure = await buildTermStructure('VIX', vixChain.expirations, 0);
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

/**
 * Evaluate 25Δ risk reversal from an in-memory options chain (for predictive
 * factors). `asOf` should be the decision date being evaluated — omit only
 * for genuinely live/real-time calls. See tradingCalendar.ts's `getDTE`.
 */
export async function evaluateRiskReversalFactor(
  contracts: PolygonOptionsContract[],
  expirations: string[],
  currentPrice: number,
  asOf?: Date,
): Promise<RiskReversalSkewResult | null> {
  const expiry = excludeZeroDte(expirations, asOf)[0];
  if (!expiry) return null;
  const dte = await getDTE(expiry, asOf);
  return computeRiskReversalFromContracts(contracts, currentPrice, expiry, dte, asOf);
}

/**
 * Evaluate IV term structure from an in-memory options chain (for predictive
 * factors). `asOf` should be the decision date being evaluated — omit only
 * for genuinely live/real-time calls.
 */
export async function evaluateTermStructureFactor(
  symbol: string,
  contracts: PolygonOptionsContract[],
  expirations: string[],
  currentPrice: number,
  asOf?: Date,
): Promise<TermStructureResult | null> {
  // Routed through buildTermStructure (not ...FromChain directly) so a
  // front-expiry-only snapshot can fall back to fetching the further expiries
  // it needs. See the note in buildTermStructure.
  return buildTermStructure(symbol, expirations, currentPrice, asOf, contracts);
}
