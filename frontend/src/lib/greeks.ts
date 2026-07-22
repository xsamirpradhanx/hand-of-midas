export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
  vanna: number;
  charm: number;
  vomma: number;
  speed: number;
  color: number;
  iv?: number;
}

/**
 * Standard normal cumulative distribution function (CDF)
 * Horner's method approximation.
 */
export function normCDF(x: number): number {
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
export function normPDF(x: number): number {
  return (1.0 / Math.sqrt(2.0 * Math.PI)) * Math.exp(-0.5 * x * x);
}

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
  // Vanna: d(Delta)/d(Vol) = d(Vega)/d(Spot)
  const vanna = vega * 100.0 * (1 - d1 / (sigma * Math.sqrt(T))) / S;
  
  // Charm: d(Delta)/d(Time). Usually scaled per day
  const q = 0; // dividend yield assumption
  const charmRaw = -n_d1 * ((2 * (r - q) * T - d2 * sigma * Math.sqrt(T)) / (2 * T * sigma * Math.sqrt(T)));
  const charm = (w === 1 ? q * discount * N_d1 : -q * discount * N_d1) + discount * charmRaw;
  const charmPerDay = charm / 365.0;

  // Vomma: d(Vega)/d(Vol)
  const vomma = vega * 100.0 * (d1 * d2 / sigma) / 100.0; // Scaled per 1%

  // Speed: d(Gamma)/d(Spot)
  const speed = -gamma / S * (d1 / (sigma * Math.sqrt(T)) + 1);

  // Color: d(Gamma)/d(Time)
  const colorRaw = -Math.exp(-q * T) * n_d1 / (2 * S * T * sigma * Math.sqrt(T)) * 
    (2 * q * T + 1 + (2 * (r - q) * T - d2 * sigma * Math.sqrt(T)) * d1 / (sigma * Math.sqrt(T)));
  const colorPerDay = colorRaw / 365.0;

  return { price, delta, gamma, theta, vega, rho, vanna, charm: charmPerDay, vomma, speed, color: colorPerDay, iv: sigma };
}

/**
 * Probability of Touch (first passage time approximation)
 */
export function probabilityOfTouch(S: number, K: number, T: number, r: number, sigma: number, type: 'call' | 'put'): number {
  if (T <= 0) return type === 'call' ? (S >= K ? 1 : 0) : (S <= K ? 1 : 0);
  if (type === 'call' && S >= K) return 1;
  if (type === 'put' && S <= K) return 1;

  // Simple approximation: exp(-2 * |ln(S/K) * (r - 0.5 * sigma^2) * T / sigma^2|)
  const drift = r - 0.5 * sigma * sigma;
  
  // First-Passage Time Reflection Principle Formula
  const d1_pot = (Math.log(S / K) + drift * T) / (sigma * Math.sqrt(T));
  const d2_pot = (Math.log(S / K) - drift * T) / (sigma * Math.sqrt(T));
  
  const p1 = type === 'call' ? normCDF(d1_pot) : normCDF(-d1_pot);
  const p2 = Math.pow(S / K, 2 * drift / (sigma * sigma)) * (type === 'call' ? normCDF(d2_pot) : normCDF(-d2_pot));
  
  return Math.min(1, Math.max(0, p1 + p2));
}

/**
 * Expected Move (1 standard deviation)
 */
export function expectedMove(S: number, sigma: number, T: number): number {
  return S * sigma * Math.sqrt(T);
}
