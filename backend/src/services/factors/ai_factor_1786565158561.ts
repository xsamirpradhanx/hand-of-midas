import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

/**
 * Volume Information Entropy Imbalance Factor (VIEIF)
 * 
 * This factor analyzes the structural order (Shannon Entropy) of volume distributions 
 * during up-periods vs down-periods. Lower entropy indicates systematic, high-conviction 
 * execution (institutional block accumulation/distribution), whereas higher entropy 
 * implies unstructured, retail-dominated noise.
 * 
 * By evaluating the information asymmetry between localized buying and selling forces 
 * and scaling targets using localized Average True Range (ATR), this factor detects 
 * high-probability institutional momentum shifts.
 */
export class VolumeInformationEntropyImbalanceFactor implements PredictiveFactor {
  public readonly name = 'Volume Information Entropy Imbalance';
  private readonly lookback = 30;
  private readonly binCount = 10;

  public async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars, currentPrice } = input;

    if (!bars || bars.length < this.lookback) {
      return null;
    }

    const activeBars = bars.slice(-this.lookback);
    
    const buyVolumes: number[] = [];
    const sellVolumes: number[] = [];
    const returns: number[] = [];
    let atrSum = 0;

    for (let i = 1; i < activeBars.length; i++) {
      const prev = activeBars[i - 1];
      const curr = activeBars[i];
      
      const logReturn = Math.log(curr.close / prev.close);
      returns.push(logReturn);

      // Simple True Range calculation
      const trueRange = Math.max(
        curr.high - curr.low,
        Math.abs(curr.high - prev.close),
        Math.abs(curr.low - prev.close)
      );
      atrSum += trueRange;

      if (logReturn >= 0) {
        buyVolumes.push(curr.volume);
      } else {
        sellVolumes.push(curr.volume);
      }
    }

    // Guarantee sufficient distribution points for both structures
    if (buyVolumes.length < 5 || sellVolumes.length < 5) {
      return {
        factorName: this.name,
        bias: 'neutral',
        weight: 0.0,
        reasoning: 'Insufficient balanced directional volume distribution to calculate information entropy safely.',
        buyTarget: currentPrice,
        sellTarget: currentPrice
      };
    }

    // Compute Shannon Entropy for both directional volume distributions
    const hBuy = this.calculateShannonEntropy(buyVolumes);
    const hSell = this.calculateShannonEntropy(sellVolumes);
    
    // Entropy Imbalance: positive means buy volume is more structured/concentrated (lower entropy)
    const entropyImbalance = hSell - hBuy;

    // Calculate annualized realized volatility over the lookback
    const meanReturn = returns.reduce((sum, val) => sum + val, 0) / returns.length;
    const variance = returns.reduce((sum, val) => sum + Math.pow(val - meanReturn, 2), 0) / (returns.length - 1);
    const realizedVol = Math.sqrt(variance);

    // Calculate average true range (ATR) for execution boundaries
    const atr = atrSum / (activeBars.length - 1);

    // Signal generation logic
    const threshold = 0.12; 
    let bias: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    
    if (entropyImbalance > threshold) {
      bias = 'bullish';
    } else if (entropyImbalance < -threshold) {
      bias = 'bearish';
    }

    // Normalize signal strength relative to historical deviation
    const signalStrength = Math.min(Math.abs(entropyImbalance) / 1.5, 1.0);
    
    // Dampen allocation scaling factor under elevated realized volatility conditions
    const volDampener = realizedVol > 0.03 ? Math.max(0.2, 1.0 - (realizedVol * 15)) : 1.0;
    const baseWeight = 0.40;
    const weight = parseFloat((baseWeight * signalStrength * volDampener).toFixed(4));

    // Dynamic target pricing based on fractional ATR boundaries
    const buyTarget = parseFloat((currentPrice - (atr * 1.2)).toFixed(2));
    const sellTarget = parseFloat((currentPrice + (atr * 1.2)).toFixed(2));

    const structuralFlow = bias === 'bullish' 
      ? 'Systematic, low-entropy accumulation detected (Institutional buy flow).' 
      : bias === 'bearish' 
      ? 'Systematic, low-entropy distribution detected (Institutional sell flow).' 
      : 'Unstructured, balanced retail noise matching Brownian motion.';

    const reasoning = `${structuralFlow} | Entropy Imbalance: ${entropyImbalance.toFixed(4)} (H_Buy: ${hBuy.toFixed(3)}, H_Sell: ${hSell.toFixed(3)}). ` +
      `Realized Volatility: ${(realizedVol * 100).toFixed(2)}%. Vol Dampener scaling applied: ${volDampener.toFixed(2)}x.`;

    return {
      factorName: this.name,
      bias,
      weight,
      reasoning,
      buyTarget,
      sellTarget
    };
  }

  /**
   * Helper to partition empirical array into static bins and compute Shannon Entropy
   */
  private calculateShannonEntropy(volumes: number[]): number {
    const totalVolume = volumes.reduce((sum, v) => sum + v, 0);
    if (totalVolume === 0) return 0;

    const min = Math.min(...volumes);
    const max = Math.max(...volumes);
    const range = max - min;

    if (range === 0) return 0;

    const bins = new Array(this.binCount).fill(0);
    for (const v of volumes) {
      const binIndex = Math.min(
        Math.floor(((v - min) / range) * this.binCount),
        this.binCount - 1
      );
      bins[binIndex] += v;
    }

    let entropy = 0;
    for (const binSum of bins) {
      const p = binSum / totalVolume;
      if (p > 0) {
        entropy -= p * Math.log2(p);
      }
    }

    return entropy;
  }
}
