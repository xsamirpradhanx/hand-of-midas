import type { PolygonOptionsContract } from '../polygon.js';

/**
 * Filter and select the optimal options contract for a given directional swing trade.
 * Targets:
 * - Contract Type: Call for LONG, Put for SHORT
 * - Expiration: >= current date + tradeHorizon + 14 days buffer
 * - Liquidity: Open Interest >= 100
 * - Strike: Closest to 0.50 Delta (ATM)
 */
export function selectOptimalContract(
  chain: PolygonOptionsContract[],
  bias: 'LONG' | 'SHORT',
  spotPrice: number,
  horizonDays: number
): PolygonOptionsContract | null {
  if (!chain || chain.length === 0) return null;

  const targetType = bias === 'LONG' ? 'call' : 'put';
  const targetDelta = bias === 'LONG' ? 0.50 : -0.50; // delta is typically negative for puts

  // 1. Calculate minimum expiration date (today + horizon + 14 days)
  const now = new Date();
  const minExpiryDate = new Date(now.getTime() + (horizonDays + 14) * 24 * 60 * 60 * 1000);
  const minExpiryStr = minExpiryDate.toISOString().split('T')[0]!;

  // 2. Filter contracts
  let validContracts = chain.filter(c => {
    if (c.details.contract_type !== targetType) return false;
    // Liquidity filter
    if ((c.day?.open_interest || 0) < 100) return false;
    // Expiration filter
    if (c.details.expiration_date < minExpiryStr) return false;
    return true;
  });

  // If no contracts pass the liquidity filter, relax it
  if (validContracts.length === 0) {
    validContracts = chain.filter(c => 
      c.details.contract_type === targetType && 
      c.details.expiration_date >= minExpiryStr
    );
  }

  // If still empty (maybe chain is too short), just pick furthest expiry
  if (validContracts.length === 0) {
    validContracts = chain.filter(c => c.details.contract_type === targetType);
  }

  if (validContracts.length === 0) return null;

  // 3. Find contract closest to 0.50 Delta (or ATM if Greeks missing).
  // Delta differences (0-1 scale) and strike differences (dollar scale) are not
  // comparable, so pick one metric for the whole set rather than mixing them
  // contract-by-contract in a single minDiff.
  const withGreeks = validContracts.filter(c => c.greeks && typeof c.greeks.delta === 'number');
  const pool = withGreeks.length > 0 ? withGreeks : validContracts;
  const useDelta = withGreeks.length > 0;

  let bestContract = pool[0]!;
  let minDiff = Infinity;

  for (const c of pool) {
    const diff = useDelta
      ? Math.abs(c.greeks!.delta! - targetDelta)
      : Math.abs(c.details.strike_price - spotPrice);
    if (diff < minDiff) {
      minDiff = diff;
      bestContract = c;
    }
  }

  return bestContract || null;
}
