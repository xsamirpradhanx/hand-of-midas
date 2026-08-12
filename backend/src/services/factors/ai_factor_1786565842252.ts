import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

/**
 * VolumeSynchronizedEntropyDivergenceFactor
 * 
 * An advanced quantitative microstructure factor that calculates the information density
 * of price returns using volume-weighted Shannon Entropy and Kaufman's Fractal Efficiency Ratio (ER).
 * 
 * Divergences between fast/slow ER coupled with low entropy (high signal-to-noise ratio)
 * identify highly structured institutional accumulation or distribution regimes before breakout propagation.
 */
export class VolumeSynchronizedEntropyDivergenceFactor implements PredictiveFactor {
  name = 'Volume-Synchronized Entropy Divergence Factor';

  private readonly fastWindow: number = 10;
  private readonly slowWindow: number = 30;
  private readonly numEntropyBins: number = 8;

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars, currentPrice } = input;

    if (!bars || bars.length < this.slowWindow + 1 || currentPrice <= 0) {
      return null;
    }

    // 1. Calculate log returns and volume weights
    const logReturns: number[] = [];
    const volumes: number[] = [];
    let totalVolume = 0;

    for (let i = 1; i < bars.length; i++) {
      const prevClose = bars[i - 1].close;
      const currClose = bars[i].close;
      
      if (prevClose <= 0 || currClose <= 0) continue;

      const r = Math.log(currClose / prevClose);
      const vol = bars[i].volume || 1;

      logReturns.push(r);
      volumes.push(vol);
      totalVolume += vol;
    }

    if (logReturns.length < this.slowWindow) {
      return null;
    }

    // 2. Compute Fast and Slow Fractal Efficiency Ratios (ER)
    const fastBars = bars.slice(-this.fastWindow - 1);
    const slowBars = bars.slice(-this.slowWindow - 1);

    const fastER = this.computeEfficiencyRatio(fastBars);
    const slowER = this.computeEfficiencyRatio(slowBars);

    // 3. Estimate Return Distribution Entropy over the slow window
    const recentReturns = logReturns.slice(-this.slowWindow);
    const shannonEntropy = this.computeShannonEntropy(recentReturns, this.numEntropyBins);
    const maxEntropy = Math.log2(this.numEntropyBins);
    
    // Normalized Shannon Entropy (0 = max order / low noise, 1 = max chaos / high noise)
    const normalizedEntropy = Math.min(1.0, Math.max(0.0, shannonEntropy / maxEntropy));
    const structuralOrderScore = 1.0 - normalizedEntropy; // Higher score = clearer trend structure

    // 4. Volume Concentration Ratio (Fast vs. Slow average volume)
    const fastVolAvg = volumes.slice(-this.fastWindow).reduce((a, b) => a + b, 0) / this.fastWindow;
    const slowVolAvg = volumes.slice(-this.slowWindow).reduce((a, b) => a + b, 0) / this.slowWindow;
    const volumeSurgeRatio = slowVolAvg > 0 ? Math.min(2.5, fastVolAvg / slowVolAvg) : 1.0;

    // 5. Microstructure Divergence Index (MDI)
    const erDelta = fastER - slowER; // Accelerating efficiency when positive
    const divergenceScore = erDelta * structuralOrderScore * volumeSurgeRatio;

    // 6. Volatility scale calculation for target placement (Sample Volatility)
    const returnStdDev = this.computeStdDev(recentReturns);
    const projectedVolatility = currentPrice * returnStdDev * Math.sqrt(this.fastWindow);

    // 7. Determine Signal Direction, Confidence Weight, and Targets
    const fastNetChange = currentPrice - bars[bars.length - this.fastWindow].close;

    let bias: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    let weight = 0.0;

    // High structural order (> 0.35) and non-negligible ER acceleration required
    if (structuralOrderScore > 0.35 && Math.abs(divergenceScore) > 0.04) {
      if (divergenceScore > 0 && fastNetChange > 0) {
        bias = 'bullish';
        weight = Math.min(0.95, Math.abs(divergenceScore) * 2.8 + structuralOrderScore * 0.25);
      } else if (divergenceScore < 0 || fastNetChange < 0) {
        bias = 'bearish';
        weight = Math.min(0.95, Math.abs(divergenceScore) * 2.8 + structuralOrderScore * 0.25);
      }
    } else {
      bias = 'neutral';
      weight = Math.max(0.05, 0.2 * structuralOrderScore);
    }

    // Dynamic Buy/Sell Target Bounds using volatility multiple scaling
    const targetMultiplier = 1.2 + weight * 1.8;
    
    let buyTarget: number;
    let sellTarget: number;

    if (bias === 'bullish') {
      buyTarget = currentPrice * (1 - 0.003); // Entry pullback level
      sellTarget = currentPrice + projectedVolatility * targetMultiplier;
    } else if (bias === 'bearish') {
      buyTarget = currentPrice - projectedVolatility * targetMultiplier;
      sellTarget = currentPrice * (1 + 0.003); // Risk stop level
    } else {
      buyTarget = currentPrice - projectedVolatility;
      sellTarget = currentPrice + projectedVolatility;
    }

    const reasoning = 
      `VSED Factor [${bias.toUpperCase()}]: Entropy Order = ${structuralOrderScore.toFixed(3)} ` +
      `(Entropy = ${shannonEntropy.toFixed(3)} bits), Fast ER (${this.fastWindow}) = ${fastER.toFixed(3)}, ` +
      `Slow ER (${this.slowWindow}) = ${slowER.toFixed(3)}, Vol Surge = ${volumeSurgeRatio.toFixed(2)}x. ` +
      `Divergence Score = ${divergenceScore.toFixed(4)}. Market state: ${
        structuralOrderScore > 0.5 ? 'High Order / Active Institutional Flow' : 'High Entropy / Random Walk Noise'
      }.`;

    return {
      factorName: this.name,
      bias,
      weight: Number(weight.toFixed(4)),
      reasoning,
      buyTarget: Number(buyTarget.toFixed(4)),
      sellTarget: Number(sellTarget.toFixed(4)),
    };
  }

  /**
   * Computes Kaufman's Efficiency Ratio (ER)
   * ER = Direct Price Distance / Cumulative Path Distance
   */
  private computeEfficiencyRatio(bars: Array<{ close: number }>): number {
    if (bars.length < 2) return 0;
    
    const netDistance = Math.abs(bars[bars.length - 1].close - bars[0].close);
    let totalPathDistance = 0;

    for (let i = 1; i < bars.length; i++) {
      totalPathDistance += Math.abs(bars[i].close - bars[i - 1].close);
    }

    return totalPathDistance === 0 ? 0 : netDistance / totalPathDistance;
  }

  /**
   * Computes Shannon Entropy H(X) over discretized return bins
   */
  private computeShannonEntropy(data: number[], numBins: number): number {
    if (data.length === 0) return 0;

    const min = Math.min(...data);
    const max = Math.max(...data);

    if (min === max) return 0;

    const binWidth = (max - min) / numBins;
    const binCounts = new Array(numBins).fill(0);

    for (const val of data) {
      let idx = Math.floor((val - min) / binWidth);
      if (idx >= numBins) idx = numBins - 1;
      binCounts[idx]++;
    }

    let entropy = 0;
    const totalSamples = data.length;

    for (const count of binCounts) {
      if (count > 0) {
        const p = count / totalSamples;
        entropy -= p * Math.log2(p);
      }
    }

    return entropy;
  }

  /**
   * Computes standard deviation of return series
   */
  private computeStdDev(data: number[]): number {
    if (data.length === 0) return 0;
    const mean = data.reduce((sum, val) => sum + val, 0) / data.length;
    const variance = data.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / data.length;
    return Math.sqrt(variance);
  }
}
