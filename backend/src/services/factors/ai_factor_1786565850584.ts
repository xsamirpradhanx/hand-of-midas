import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

/**
 * Spectral Microstructure Inertia Factor
 * 
 * Combines fractional differentiation (d=0.45) to maintain price memory while achieving stationarity,
 * with volume-weighted directional pressure correlation (order flow proxy).
 * Determines microstructure regime shifts and trend persistence.
 */
export class SpectralMicrostructureInertiaFactor implements PredictiveFactor {
  name = 'Spectral Microstructure Inertia Factor';

  private readonly memoryDepth = 20;
  private readonly dFraction = 0.45; // Optimal memory fraction for asset stationarity without loss of signal

  /**
   * Computes binomial expansion weights for fractional differentiation (d)
   */
  private getFractionalWeights(d: number, size: number): number[] {
    const weights: number[] = [1];
    for (let k = 1; k < size; k++) {
      const w = -weights[k - 1] * (d - k + 1) / k;
      weights.push(w);
    }
    return weights;
  }

  /**
   * Applies fractional differentiation to a price series
   */
  private fractionallyDifferentiate(series: number[], d: number): number[] {
    const weights = this.getFractionalWeights(d, Math.min(series.length, this.memoryDepth));
    const diffSeries: number[] = [];

    for (let i = weights.length - 1; i < series.length; i++) {
      let val = 0;
      for (let k = 0; k < weights.length; k++) {
        val += weights[k] * series[i - k];
      }
      diffSeries.push(val);
    }

    return diffSeries;
  }

  /**
   * Calculates Average True Range (ATR) for dynamic targeting
   */
  private calculateATR(bars: FactorInput['bars'], period: number = 14): number {
    if (bars.length < period + 1) return 0;
    let trSum = 0;
    for (let i = bars.length - period; i < bars.length; i++) {
      const high = bars[i].high;
      const low = bars[i].low;
      const prevClose = bars[i - 1].close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trSum += tr;
    }
    return trSum / period;
  }

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { bars, currentPrice } = input;

    if (!bars || bars.length < 35) {
      return null;
    }

    const closePrices = bars.map(b => b.close);

    // 1. Fractional Differentiation on Close Prices (Preserves long memory while establishing stationarity)
    const fracDiffClose = this.fractionallyDifferentiate(closePrices, this.dFraction);
    if (fracDiffClose.length === 0) return null;

    // 2. Volume-Weighted Directional Pressure (Order Flow Proxy via Close Location Value * Volume)
    const volumeFlow: number[] = [];
    const windowStart = bars.length - fracDiffClose.length;
    for (let i = windowStart; i < bars.length; i++) {
      const bar = bars[i];
      const range = bar.high - bar.low;
      const clv = range === 0 ? 0 : ((bar.close - bar.low) - (bar.high - bar.close)) / range;
      volumeFlow.push(clv * bar.volume);
    }

    // 3. Compute Microstructure Inertia (Pearson Covariance between FracDiff Price Derivative & Volume Pressure)
    const n = fracDiffClose.length;
    let meanFrac = 0;
    let meanVol = 0;
    for (let i = 0; i < n; i++) {
      meanFrac += fracDiffClose[i];
      meanVol += volumeFlow[i];
    }
    meanFrac /= n;
    meanVol /= n;

    let covariance = 0;
    let varFrac = 0;
    let varVol = 0;

    for (let i = 0; i < n; i++) {
      const diffFrac = fracDiffClose[i] - meanFrac;
      const diffVol = volumeFlow[i] - meanVol;
      covariance += diffFrac * diffVol;
      varFrac += diffFrac * diffFrac;
      varVol += diffVol * diffVol;
    }

    const stdFrac = Math.sqrt(varFrac / n);
    const stdVol = Math.sqrt(varVol / n);

    // Pearson correlation measuring alignment of fractional price velocity & institutional order flow
    const inertiaCorrelation = (stdFrac > 0 && stdVol > 0) ? (covariance / n) / (stdFrac * stdVol) : 0;

    // Standardized latest fractionally differentiated price momentum (Z-Score)
    const latestFracDiff = fracDiffClose[fracDiffClose.length - 1];
    const fracDiffZScore = stdFrac > 0 ? (latestFracDiff - meanFrac) / stdFrac : 0;

    // Composite Signal: FracDiff velocity boosted by order flow inertia alignment
    const compositeSignal = fracDiffZScore * (1 + Math.max(0, inertiaCorrelation));

    // Determine Directional Bias & Weight
    let bias: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    if (compositeSignal > 0.8) {
      bias = 'bullish';
    } else if (compositeSignal < -0.8) {
      bias = 'bearish';
    }

    // Sigmoidal scaling for factor weight confidence [0.0, 1.0]
    const rawWeight = 1 / (1 + Math.exp(-Math.abs(compositeSignal) + 1.5));
    const weight = Math.min(Math.max(Math.round(rawWeight * 100) / 100, 0), 1);

    // Dynamic Volatility Targets using ATR
    const atr = this.calculateATR(bars, 14);
    const buyTarget = bias === 'bullish' 
      ? currentPrice - (atr * 0.4) 
      : currentPrice - (atr * 1.5);
    const sellTarget = bias === 'bullish' 
      ? currentPrice + (atr * 1.5) 
      : currentPrice + (atr * 0.4);

    return {
      factorName: this.name,
      bias,
      weight,
      reasoning: `FracDiff(d=${this.dFraction}) Z-Score: ${fracDiffZScore.toFixed(2)}, Microstructure Flow Inertia Corr: ${inertiaCorrelation.toFixed(2)}. Composite Intensity: ${compositeSignal.toFixed(2)}.`,
      buyTarget: Math.round(buyTarget * 100) / 100,
      sellTarget: Math.round(sellTarget * 100) / 100
    };
  }
}
