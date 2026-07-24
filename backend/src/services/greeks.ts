// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
  vanna?: number;
  charm?: number;
  vomma?: number;
  speed?: number;
  color?: number;
  iv?: number;
}

export interface PositionSummary {
  symbol: string;
  side: 'call' | 'put';
  quantity: number;
  multiplier: number;
  greeks: Greeks;
  underlyingPrice: number;
  betaVsSPY?: number;
}

export interface PortfolioGreeks {
  netDelta: number;
  netGamma: number;
  netThetaPerDay: number;
  netVega: number;
  betaWeightedDelta: number;
}

// ---------------------------------------------------------------------------
// Math Helpers
// ---------------------------------------------------------------------------

/**
 * Standard normal cumulative distribution function (CDF)
 * Horner's method approximation (error < 7.5e-8).
 */
function normCDF(x: number): number {
  const L = Math.abs(x);
  if (L >= 8.0) return x >= 0 ? 1.0 : 0.0;
  
  const d1 = 0.0498673470;
  const d2 = 0.0211410061;
  const d3 = 0.0032776263;
  const d4 = 0.0000380036;
  const d5 = 0.0000488906;
  const d6 = 0.0000053830;
  
  const p = 1.0 + L * (d1 + L * (d2 + L * (d3 + L * (d4 + L * (d5 + L * d6)))));
  const pow16 = Math.pow(p, 16);
  const prob = 1.0 - 0.5 / pow16;
  
  return x >= 0 ? prob : 1.0 - prob;
}

/**
 * Standard normal probability density function (PDF)
 */
function normPDF(x: number): number {
  return (1.0 / Math.sqrt(2.0 * Math.PI)) * Math.exp(-0.5 * x * x);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Black-Scholes for European options.
 */
export function blackScholes(S: number, K: number, T: number, r: number, sigma: number, type: 'call' | 'put'): Greeks {
  if (T <= 0) {
    const isCall = type === 'call';
    const price = Math.max(0, isCall ? S - K : K - S);
    return { price, delta: isCall && price > 0 ? 1 : (!isCall && price > 0 ? -1 : 0), gamma: 0, theta: 0, vega: 0, rho: 0, vanna: 0, charm: 0, vomma: 0, speed: 0, color: 0, iv: sigma };
  }

  if (sigma <= 0) {
    // Intrinsic value
    const pvK = K * Math.exp(-r * T);
    const isCall = type === 'call';
    const price = Math.max(0, isCall ? S - pvK : pvK - S);
    return { price, delta: isCall && S > pvK ? 1 : (!isCall && S < pvK ? -1 : 0), gamma: 0, theta: 0, vega: 0, rho: 0, vanna: 0, charm: 0, vomma: 0, speed: 0, color: 0, iv: sigma };
  }

  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2.0) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);

  const isCall = type === 'call';
  const w = isCall ? 1 : -1;

  const N_d1 = normCDF(w * d1);
  const N_d2 = normCDF(w * d2);
  const n_d1 = normPDF(d1);

  const discount = Math.exp(-r * T);

  const price = w * (S * N_d1 - K * discount * N_d2);
  const delta = w * N_d1;
  const gamma = n_d1 / (S * sigma * Math.sqrt(T));
  const vega = S * n_d1 * Math.sqrt(T) / 100.0; // Per 1%
  const rho = w * K * T * discount * N_d2 / 100.0; // Per 1%

  const theta1 = -(S * n_d1 * sigma) / (2.0 * Math.sqrt(T));
  const theta2 = w * r * K * discount * N_d2;
  const theta = (theta1 - theta2) / 365.0; // Per day

  // Higher-Order Greeks
  const vanna = vega * 100.0 * (1 - d1 / (sigma * Math.sqrt(T))) / S;
  
  const q = 0; // dividend yield assumption
  const charmRaw = -n_d1 * ((2 * (r - q) * T - d2 * sigma * Math.sqrt(T)) / (2 * T * sigma * Math.sqrt(T)));
  const charm = (w === 1 ? q * discount * N_d1 : -q * discount * N_d1) + discount * charmRaw;
  const charmPerDay = charm / 365.0;

  const vomma = vega * 100.0 * (d1 * d2 / sigma) / 100.0;
  const speed = -gamma / S * (d1 / (sigma * Math.sqrt(T)) + 1);

  const colorRaw = -Math.exp(-q * T) * n_d1 / (2 * S * T * sigma * Math.sqrt(T)) * 
    (2 * q * T + 1 + (2 * (r - q) * T - d2 * sigma * Math.sqrt(T)) * d1 / (sigma * Math.sqrt(T)));
  const colorPerDay = colorRaw / 365.0;

  return { price, delta, gamma, theta, vega, rho, vanna, charm: charmPerDay, vomma, speed, color: colorPerDay, iv: sigma };
}

/**
 * Centralized risk-free rate fetching.
 * TODO: Integrate an actual dated yield curve API.
 */
export function getRiskFreeRate(symbol?: string, dte?: number): number {
  return 0.05;
}

/**
 * Centralized dividend yield / borrow rate fetching.
 * TODO: Integrate an actual dividend yield / borrow rate service.
 */
export function getDividendYield(symbol?: string): number {
  return 0.0;
}

/**
 * American Option proxy pricing (European Black-Scholes or Intrinsic).
 * Do not label as Bjerksund-Stensland until a validated implementation is present.
 */
export function americanProxy(S: number, K: number, T: number, r: number, q: number, sigma: number, type: 'call' | 'put'): Greeks {
  // Compute price first
  const price = americanProxyPrice(S, K, T, r, q, sigma, type);
  
  if (T <= 0 || sigma <= 0) {
    // Fall back to BSM for edge cases where greeks are trivial
    const bsm = blackScholes(S, K, T, r, sigma, type);
    bsm.price = price;
    return bsm;
  }

  // Compute greeks via finite differences
  const dS = S * 0.001;
  const priceUp = americanProxyPrice(S + dS, K, T, r, q, sigma, type);
  const priceDown = americanProxyPrice(S - dS, K, T, r, q, sigma, type);
  
  const delta = (priceUp - priceDown) / (2 * dS);
  const gamma = (priceUp - 2 * price + priceDown) / (dS * dS);

  const dT = 1 / 365;
  const priceT = T > dT ? americanProxyPrice(S, K, T - dT, r, q, sigma, type) : Math.max(0, type === 'call' ? S - K : K - S);
  const theta = priceT - price; // Price tomorrow minus price today

  const dSigma = 0.01; // 1%
  const priceVolUp = americanProxyPrice(S, K, T, r, q, sigma + dSigma, type);
  const vega = priceVolUp - price; // Already per 1%

  const dR = 0.01; // 1%
  const priceRUp = americanProxyPrice(S, K, T, r + dR, q, sigma, type);
  const rho = priceRUp - price; // Already per 1%

  return { price, delta, gamma, theta, vega, rho, iv: sigma };
}

/** Helper for American proxy calculation. */
function americanProxyPrice(S: number, K: number, T: number, r: number, q: number, sigma: number, type: 'call' | 'put'): number {
  if (type === 'put') {
    // Use put-call symmetry for American options: P(S, K, r, q, T) = C(K, S, q, r, T)
    return americanProxyPriceCall(K, S, T, q, r, sigma);
  }
  return americanProxyPriceCall(S, K, T, r, q, sigma);
}

function americanProxyPriceCall(S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  const b = r - q;
  if (b >= r) { // Equivalent to q <= 0
    // American call on non-dividend paying stock is same as European
    return blackScholes(S, K, T, r, sigma, 'call').price;
  }
  
  const bsmPrice = blackScholes(S, K, T, r, sigma, 'call').price;
  const intrinsic = Math.max(0, S - K);
  return Math.max(bsmPrice, intrinsic); 
}

/**
 * Newton-Raphson IV solver with bisection fallback.
 */
export function impliedVolatility(marketPrice: number, S: number, K: number, T: number, r: number, type: 'call' | 'put'): number | null {
  const intrinsic = Math.max(0, type === 'call' ? S - K : K - S);
  if (marketPrice < intrinsic) {
    return null; // Arbitrage violation, no IV
  }
  if (T <= 0) return null;

  let sigma = 0.5; // Initial guess
  const maxIterNR = 10;
  const tol = 0.0001;

  for (let i = 0; i < maxIterNR; i++) {
    const greeks = blackScholes(S, K, T, r, sigma, type);
    const diff = greeks.price - marketPrice;
    
    if (Math.abs(diff) < tol) return sigma;
    
    const vega = greeks.vega * 100; // vega is scaled by 100, we need dC/dsigma
    if (Math.abs(vega) < 1e-6) break; // Avoid division by zero
    
    sigma = sigma - diff / vega;
    if (sigma <= 0 || sigma > 5.0) break; // Diverged
  }

  // Fallback to bisection
  let low = 0.001;
  let high = 5.0;
  const maxIterBisect = 100;

  for (let i = 0; i < maxIterBisect; i++) {
    sigma = (low + high) / 2.0;
    const greeks = blackScholes(S, K, T, r, sigma, type);
    const diff = greeks.price - marketPrice;
    
    if (Math.abs(diff) < tol) return sigma;
    
    if (diff > 0) {
      high = sigma;
    } else {
      low = sigma;
    }
  }

  return null;
}

/**
 * Aggregate position-level Greeks.
 */
export function computePortfolioGreeks(positions: PositionSummary[], spyPrice: number): PortfolioGreeks {
  let netDelta = 0;
  let netGamma = 0;
  let netThetaPerDay = 0;
  let netVega = 0;
  let betaWeightedDelta = 0;

  for (const pos of positions) {
    const multiplier = pos.multiplier;
    const q = pos.quantity;
    
    // Delta and gamma are reported as underlying share-equivalent exposures.
    // Dollar exposures belong in a separately labelled report.
    const posDelta = pos.greeks.delta * q * multiplier;
    const posGamma = pos.greeks.gamma * q * multiplier;
    const posTheta = pos.greeks.theta * q * multiplier;
    const posVega = pos.greeks.vega * q * multiplier;

    netDelta += posDelta;
    netGamma += posGamma;
    netThetaPerDay += posTheta;
    netVega += posVega;

    const beta = pos.betaVsSPY ?? 1.0;
    // Beta weighted delta standardizes the delta relative to SPY
    betaWeightedDelta += (posDelta * beta);
  }

  return {
    netDelta,
    netGamma,
    netThetaPerDay,
    netVega,
    betaWeightedDelta,
  };
}
