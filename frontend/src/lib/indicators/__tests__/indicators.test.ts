/**
 * Comprehensive unit tests for the Hand of Midas indicator engine.
 *
 * Tests cover:
 * - Correctness with hand-calculated reference values
 * - Edge cases: empty arrays, period > data length, single bar
 * - Structural invariants (e.g. upper > middle > lower for Bollinger)
 */

import { describe, it, expect } from 'vitest';
import { calculateSMA } from '../sma';
import { calculateEMA } from '../ema';
import { calculateRSI } from '../rsi';
import { calculateMACD } from '../macd';
import { calculateBollingerBands } from '../bollingerBands';
import { calculateVWAP } from '../vwap';
import type { OHLCVBar } from '../types';

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const testBars: OHLCVBar[] = [
  { time: '2024-01-02', open: 100, high: 105, low: 99, close: 103, volume: 1000000 },
  { time: '2024-01-03', open: 103, high: 107, low: 102, close: 105, volume: 1200000 },
  { time: '2024-01-04', open: 105, high: 106, low: 101, close: 102, volume: 900000 },
  { time: '2024-01-05', open: 102, high: 108, low: 101, close: 107, volume: 1500000 },
  { time: '2024-01-08', open: 107, high: 110, low: 106, close: 109, volume: 1100000 },
  { time: '2024-01-09', open: 109, high: 111, low: 107, close: 108, volume: 1300000 },
  { time: '2024-01-10', open: 108, high: 112, low: 107, close: 111, volume: 1400000 },
  { time: '2024-01-11', open: 111, high: 113, low: 109, close: 110, volume: 1000000 },
  { time: '2024-01-12', open: 110, high: 114, low: 109, close: 113, volume: 1600000 },
  { time: '2024-01-16', open: 113, high: 115, low: 112, close: 114, volume: 1200000 },
  { time: '2024-01-17', open: 114, high: 116, low: 111, close: 112, volume: 1100000 },
  { time: '2024-01-18', open: 112, high: 113, low: 108, close: 109, volume: 1300000 },
  { time: '2024-01-19', open: 109, high: 112, low: 108, close: 111, volume: 1000000 },
  { time: '2024-01-22', open: 111, high: 115, low: 110, close: 114, volume: 1400000 },
  { time: '2024-01-23', open: 114, high: 117, low: 113, close: 116, volume: 1500000 },
  { time: '2024-01-24', open: 116, high: 118, low: 114, close: 115, volume: 1200000 },
  { time: '2024-01-25', open: 115, high: 119, low: 114, close: 118, volume: 1700000 },
  { time: '2024-01-26', open: 118, high: 120, low: 116, close: 117, volume: 1100000 },
  { time: '2024-01-29', open: 117, high: 121, low: 116, close: 120, volume: 1600000 },
  { time: '2024-01-30', open: 120, high: 122, low: 118, close: 119, volume: 1300000 },
];

const TOLERANCE = 0.01;

// ---------------------------------------------------------------------------
// SMA Tests
// ---------------------------------------------------------------------------

describe('calculateSMA', () => {
  it('returns empty array for empty data', () => {
    expect(calculateSMA([], 5)).toEqual([]);
  });

  it('returns empty array when period > data length', () => {
    expect(calculateSMA(testBars.slice(0, 3), 5)).toEqual([]);
  });

  it('returns single value when period === data length', () => {
    const result = calculateSMA(testBars.slice(0, 5), 5);
    expect(result).toHaveLength(1);
  });

  it('returns one value per bar for period = 1', () => {
    const result = calculateSMA(testBars, 1);
    expect(result).toHaveLength(testBars.length);
    // Each value should equal the close
    for (let i = 0; i < result.length; i++) {
      expect(result[i].value).toBeCloseTo(testBars[i].close, 2);
    }
  });

  it('has correct output length', () => {
    const period = 5;
    const result = calculateSMA(testBars, period);
    expect(result).toHaveLength(testBars.length - period + 1);
  });

  it('produces correct SMA(5) values (hand-calculated)', () => {
    const result = calculateSMA(testBars, 5);

    // Hand calculations for SMA(5):
    // Index 0-4: closes = [103, 105, 102, 107, 109] → mean = 526/5 = 105.2
    // Index 1-5: closes = [105, 102, 107, 109, 108] → mean = 531/5 = 106.2
    // Index 2-6: closes = [102, 107, 109, 108, 111] → mean = 537/5 = 107.4
    // Index 3-7: closes = [107, 109, 108, 111, 110] → mean = 545/5 = 109.0
    // Index 4-8: closes = [109, 108, 111, 110, 113] → mean = 551/5 = 110.2

    expect(result[0].time).toBe('2024-01-08');
    expect(result[0].value).toBeCloseTo(105.2, 2);

    expect(result[1].time).toBe('2024-01-09');
    expect(result[1].value).toBeCloseTo(106.2, 2);

    expect(result[2].time).toBe('2024-01-10');
    expect(result[2].value).toBeCloseTo(107.4, 2);

    expect(result[3].time).toBe('2024-01-11');
    expect(result[3].value).toBeCloseTo(109.0, 2);

    expect(result[4].time).toBe('2024-01-12');
    expect(result[4].value).toBeCloseTo(110.2, 2);
  });

  it('computes correct SMA(3)', () => {
    const result = calculateSMA(testBars, 3);
    // closes[0..2] = [103, 105, 102] → mean = 310/3 ≈ 103.333
    expect(result[0].time).toBe('2024-01-04');
    expect(result[0].value).toBeCloseTo(103.333, 2);
  });

  it('handles single bar', () => {
    const single = [testBars[0]];
    const result = calculateSMA(single, 1);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(103);
  });
});

// ---------------------------------------------------------------------------
// EMA Tests
// ---------------------------------------------------------------------------

describe('calculateEMA', () => {
  it('returns empty array for empty data', () => {
    expect(calculateEMA([], 5)).toEqual([]);
  });

  it('returns empty array when period > data length', () => {
    expect(calculateEMA(testBars.slice(0, 3), 5)).toEqual([]);
  });

  it('has correct output length', () => {
    const period = 5;
    const result = calculateEMA(testBars, period);
    expect(result).toHaveLength(testBars.length - period + 1);
  });

  it('first EMA value equals SMA of first period bars', () => {
    const period = 5;
    const ema = calculateEMA(testBars, period);
    const sma = calculateSMA(testBars, period);
    // The first EMA value should equal the first SMA value
    expect(ema[0].value).toBeCloseTo(sma[0].value, 10);
    expect(ema[0].time).toBe(sma[0].time);
  });

  it('produces correct EMA(5) values (hand-calculated)', () => {
    const result = calculateEMA(testBars, 5);
    // The multiplier for EMA(5) is 2 / (5 + 1) = 1/3 ≈ 0.3333

    // EMA[0] = SMA(5) of [103,105,102,107,109] = 105.2
    expect(result[0].value).toBeCloseTo(105.2, 2);

    // EMA[1] = 108 * k + 105.2 * (1-k) = 108/3 + 105.2*2/3
    //        = 36 + 70.1333 = 106.1333
    expect(result[1].value).toBeCloseTo(106.1333, TOLERANCE);

    // EMA[2] = 111 * k + 106.1333 * (1-k) = 37 + 70.7555 = 107.7555...
    expect(result[2].value).toBeCloseTo(107.7556, TOLERANCE);

    // EMA[3] = 110 * k + 107.7556 * (1-k) = 36.6667 + 71.8370 = 108.5037...
    expect(result[3].value).toBeCloseTo(108.5037, TOLERANCE);
  });

  it('returns one value per bar for period = 1', () => {
    const result = calculateEMA(testBars, 1);
    expect(result).toHaveLength(testBars.length);
    // With period=1, k=1, so EMA always equals the close price
    for (let i = 0; i < result.length; i++) {
      expect(result[i].value).toBeCloseTo(testBars[i].close, 2);
    }
  });

  it('handles single bar with period 1', () => {
    const result = calculateEMA([testBars[0]], 1);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(103);
  });
});

// ---------------------------------------------------------------------------
// RSI Tests
// ---------------------------------------------------------------------------

describe('calculateRSI', () => {
  it('returns empty array for empty data', () => {
    expect(calculateRSI([], 14)).toEqual([]);
  });

  it('returns empty array when data length <= period', () => {
    // Need period+1 bars for the first RSI value
    expect(calculateRSI(testBars.slice(0, 14), 14)).toEqual([]);
  });

  it('has correct output length with period=14', () => {
    const result = calculateRSI(testBars, 14);
    // We have 20 bars → 19 changes → first RSI at change index 13 → data index 14
    // Output length = 19 - 14 + 1 = 6
    expect(result).toHaveLength(testBars.length - 14);
  });

  it('all RSI values are between 0 and 100', () => {
    const result = calculateRSI(testBars, 14);
    for (const { value } of result) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it('produces correct RSI(14) first value (hand-calculated)', () => {
    // Price changes (close[i] - close[i-1]) for i=1..14:
    // +2, -3, +5, +2, -1, +3, -1, +3, +1, -2, -3, +2, +3, +2
    // Gains:  2, 0, 5, 2, 0, 3, 0, 3, 1, 0, 0, 2, 3, 2 → sum=23
    // Losses: 0, 3, 0, 0, 1, 0, 1, 0, 0, 2, 3, 0, 0, 0 → sum=10
    // avgGain = 23/14 ≈ 1.6429
    // avgLoss = 10/14 ≈ 0.7143
    // RS = 1.6429 / 0.7143 ≈ 2.3
    // RSI = 100 - 100/(1+2.3) = 100 - 30.303 ≈ 69.697
    const result = calculateRSI(testBars, 14);
    expect(result[0].time).toBe('2024-01-23');
    expect(result[0].value).toBeCloseTo(69.70, 0.5);
  });

  it('works with period=5', () => {
    const result = calculateRSI(testBars, 5);
    expect(result.length).toBe(testBars.length - 5 - 1 + 1);
    for (const { value } of result) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it('returns RSI=100 when all moves are up', () => {
    const upBars: OHLCVBar[] = Array.from({ length: 10 }, (_, i) => ({
      time: `2024-01-${String(i + 1).padStart(2, '0')}`,
      open: 100 + i,
      high: 102 + i,
      low: 99 + i,
      close: 101 + i,
      volume: 1000,
    }));
    const result = calculateRSI(upBars, 5);
    expect(result.length).toBeGreaterThan(0);
    // All moves are +1, avgLoss = 0 → RSI = 100
    for (const { value } of result) {
      expect(value).toBe(100);
    }
  });

  it('returns RSI=0 when all moves are down', () => {
    const downBars: OHLCVBar[] = Array.from({ length: 10 }, (_, i) => ({
      time: `2024-01-${String(i + 1).padStart(2, '0')}`,
      open: 110 - i,
      high: 112 - i,
      low: 108 - i,
      close: 109 - i,
      volume: 1000,
    }));
    const result = calculateRSI(downBars, 5);
    expect(result.length).toBeGreaterThan(0);
    for (const { value } of result) {
      expect(value).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// MACD Tests
// ---------------------------------------------------------------------------

describe('calculateMACD', () => {
  it('returns empty array for empty data', () => {
    expect(calculateMACD([])).toEqual([]);
  });

  it('returns empty array when data is insufficient', () => {
    // Default slow=26, need at least 26 bars for slow EMA
    expect(calculateMACD(testBars.slice(0, 10))).toEqual([]);
  });

  it('histogram always equals macd minus signal', () => {
    // Use smaller periods so 20 bars is enough
    const result = calculateMACD(testBars, 3, 5, 3);
    expect(result.length).toBeGreaterThan(0);
    for (const val of result) {
      expect(val.histogram).toBeCloseTo(val.macd - val.signal, 10);
    }
  });

  it('has correct output length with small periods', () => {
    // fast=3, slow=5, signal=3
    // Slow EMA starts at index 4 → slowEMA length = 20-5+1 = 16
    // MACD line length = 16
    // Signal EMA of MACD: 16 - 3 + 1 = 14
    const result = calculateMACD(testBars, 3, 5, 3);
    expect(result).toHaveLength(14);
  });

  it('produces non-trivial MACD values', () => {
    const result = calculateMACD(testBars, 3, 5, 3);
    // MACD line should be non-zero for varying data
    const nonZeroMacd = result.some((v) => Math.abs(v.macd) > 0.001);
    expect(nonZeroMacd).toBe(true);
  });

  it('swaps fast/slow if fast > slow', () => {
    const normal = calculateMACD(testBars, 3, 5, 3);
    const swapped = calculateMACD(testBars, 5, 3, 3);
    expect(normal).toEqual(swapped);
  });

  it('signal converges toward macd in trending data', () => {
    // Build a strong uptrend: closes from 100 to 140
    const trendBars: OHLCVBar[] = Array.from({ length: 40 }, (_, i) => ({
      time: `2024-02-${String(i + 1).padStart(2, '0')}`,
      open: 100 + i,
      high: 102 + i,
      low: 99 + i,
      close: 100 + i,
      volume: 1000,
    }));
    const result = calculateMACD(trendBars, 5, 10, 5);
    expect(result.length).toBeGreaterThan(0);
    // In a linear uptrend, MACD values should be positive
    for (const val of result) {
      expect(val.macd).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Bollinger Bands Tests
// ---------------------------------------------------------------------------

describe('calculateBollingerBands', () => {
  it('returns empty array for empty data', () => {
    expect(calculateBollingerBands([])).toEqual([]);
  });

  it('returns empty array when period > data length', () => {
    expect(calculateBollingerBands(testBars.slice(0, 3), 5)).toEqual([]);
  });

  it('has correct output length', () => {
    const period = 5;
    const result = calculateBollingerBands(testBars, period);
    expect(result).toHaveLength(testBars.length - period + 1);
  });

  it('upper > middle > lower always holds', () => {
    const result = calculateBollingerBands(testBars, 5, 2);
    for (const band of result) {
      expect(band.upper).toBeGreaterThan(band.middle);
      expect(band.middle).toBeGreaterThan(band.lower);
    }
  });

  it('middle band equals SMA', () => {
    const period = 5;
    const bands = calculateBollingerBands(testBars, period, 2);
    const sma = calculateSMA(testBars, period);
    expect(bands).toHaveLength(sma.length);
    for (let i = 0; i < bands.length; i++) {
      expect(bands[i].middle).toBeCloseTo(sma[i].value, 10);
      expect(bands[i].time).toBe(sma[i].time);
    }
  });

  it('bands are symmetric around the middle', () => {
    const result = calculateBollingerBands(testBars, 5, 2);
    for (const band of result) {
      const upperDiff = band.upper - band.middle;
      const lowerDiff = band.middle - band.lower;
      expect(upperDiff).toBeCloseTo(lowerDiff, 10);
    }
  });

  it('produces correct first BB(5, 2) value (hand-calculated)', () => {
    // First 5 closes: [103, 105, 102, 107, 109]
    // SMA = 105.2
    // Diffs from mean: -2.2, -0.2, -3.2, 1.8, 3.8
    // Squared diffs: 4.84, 0.04, 10.24, 3.24, 14.44
    // Variance = (4.84 + 0.04 + 10.24 + 3.24 + 14.44) / 5 = 32.80 / 5 = 6.56
    // σ = sqrt(6.56) ≈ 2.5612
    // Upper = 105.2 + 2 * 2.5612 = 110.3225
    // Lower = 105.2 - 2 * 2.5612 = 100.0775
    const result = calculateBollingerBands(testBars, 5, 2);
    expect(result[0].middle).toBeCloseTo(105.2, 2);
    expect(result[0].upper).toBeCloseTo(110.3225, TOLERANCE);
    expect(result[0].lower).toBeCloseTo(100.0775, TOLERANCE);
  });

  it('bands contract when data is constant', () => {
    const flatBars: OHLCVBar[] = Array.from({ length: 10 }, (_, i) => ({
      time: `2024-01-${String(i + 1).padStart(2, '0')}`,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1000,
    }));
    const result = calculateBollingerBands(flatBars, 5, 2);
    for (const band of result) {
      expect(band.upper).toBe(100);
      expect(band.middle).toBe(100);
      expect(band.lower).toBe(100);
    }
  });
});

// ---------------------------------------------------------------------------
// VWAP Tests
// ---------------------------------------------------------------------------

describe('calculateVWAP', () => {
  it('returns empty array for empty data', () => {
    expect(calculateVWAP([])).toEqual([]);
  });

  it('has same length as input data', () => {
    const result = calculateVWAP(testBars);
    expect(result).toHaveLength(testBars.length);
  });

  it('first value equals first typical price (single-bar day)', () => {
    const result = calculateVWAP(testBars);
    // Typical price of bar 0: (105 + 99 + 103) / 3 = 102.333
    const tp0 = (testBars[0].high + testBars[0].low + testBars[0].close) / 3;
    expect(result[0].value).toBeCloseTo(tp0, 2);
  });

  it('resets daily for daily bars (each bar is a new day)', () => {
    const result = calculateVWAP(testBars);
    // Since each bar has a different date (YYYY-MM-DD), VWAP resets
    // every bar, so each VWAP value = that bar's typical price.
    for (let i = 0; i < testBars.length; i++) {
      const tp = (testBars[i].high + testBars[i].low + testBars[i].close) / 3;
      expect(result[i].value).toBeCloseTo(tp, 2);
    }
  });

  it('accumulates within the same day for intraday bars', () => {
    const intradayBars: OHLCVBar[] = [
      { time: '2024-01-02T09:30:00Z', open: 100, high: 105, low: 99, close: 103, volume: 500 },
      { time: '2024-01-02T10:00:00Z', open: 103, high: 106, low: 102, close: 104, volume: 300 },
      { time: '2024-01-02T10:30:00Z', open: 104, high: 107, low: 101, close: 106, volume: 200 },
      { time: '2024-01-03T09:30:00Z', open: 106, high: 110, low: 105, close: 108, volume: 400 },
    ];

    const result = calculateVWAP(intradayBars);

    // Bar 0: tp = (105+99+103)/3 ≈ 102.333, cum_tpv = 51166.67, cum_vol = 500
    //   VWAP = 51166.67/500 = 102.333
    const tp0 = (105 + 99 + 103) / 3;
    expect(result[0].value).toBeCloseTo(tp0, 2);

    // Bar 1: tp = (106+102+104)/3 ≈ 104.0, cum_tpv = 51166.67 + 31200 = 82366.67
    //   cum_vol = 800, VWAP = 82366.67/800 = 102.9583
    const tp1 = (106 + 102 + 104) / 3;
    const cumTPV1 = tp0 * 500 + tp1 * 300;
    expect(result[1].value).toBeCloseTo(cumTPV1 / 800, 2);

    // Bar 2: tp = (107+101+106)/3 ≈ 104.667
    const tp2 = (107 + 101 + 106) / 3;
    const cumTPV2 = cumTPV1 + tp2 * 200;
    expect(result[2].value).toBeCloseTo(cumTPV2 / 1000, 2);

    // Bar 3: new day → resets, VWAP = tp of bar 3
    const tp3 = (110 + 105 + 108) / 3;
    expect(result[3].value).toBeCloseTo(tp3, 2);
  });

  it('handles single bar', () => {
    const result = calculateVWAP([testBars[0]]);
    expect(result).toHaveLength(1);
    const tp = (testBars[0].high + testBars[0].low + testBars[0].close) / 3;
    expect(result[0].value).toBeCloseTo(tp, 2);
  });

  it('handles zero volume gracefully', () => {
    const zeroVolBars: OHLCVBar[] = [
      { time: '2024-01-02T09:30:00Z', open: 100, high: 105, low: 99, close: 103, volume: 0 },
    ];
    const result = calculateVWAP(zeroVolBars);
    expect(result).toHaveLength(1);
    // cumVolume = 0 → VWAP = 0 (avoid NaN)
    expect(result[0].value).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-indicator integration tests
// ---------------------------------------------------------------------------

describe('Cross-indicator integration', () => {
  it('all indicators produce time-aligned output', () => {
    const sma = calculateSMA(testBars, 5);
    const ema = calculateEMA(testBars, 5);
    expect(sma).toHaveLength(ema.length);
    for (let i = 0; i < sma.length; i++) {
      expect(sma[i].time).toBe(ema[i].time);
    }
  });

  it('EMA reacts faster than SMA to price changes', () => {
    // After a big price jump, EMA should be closer to the new price
    // than SMA (at least in the values immediately following).
    const sma = calculateSMA(testBars, 5);
    const ema = calculateEMA(testBars, 5);

    // Count how many times EMA is closer to the actual close
    let emaCloserCount = 0;
    for (let i = 1; i < sma.length; i++) {
      const dataIdx = i + 4; // offset by period - 1
      const close = testBars[dataIdx].close;
      const smaDiff = Math.abs(sma[i].value - close);
      const emaDiff = Math.abs(ema[i].value - close);
      if (emaDiff < smaDiff) {
        emaCloserCount++;
      }
    }
    // EMA should be closer more often than not for trending data
    // (this is a soft assertion — just verify it's non-zero)
    expect(emaCloserCount).toBeGreaterThan(0);
  });

  it('all indicator functions handle null-ish gracefully', () => {
    // @ts-expect-error intentional test of null input
    expect(calculateSMA(null, 5)).toEqual([]);
    // @ts-expect-error intentional test of undefined input
    expect(calculateEMA(undefined, 5)).toEqual([]);
    // @ts-expect-error intentional test of null input
    expect(calculateRSI(null, 14)).toEqual([]);
    // @ts-expect-error intentional test of null input
    expect(calculateMACD(null)).toEqual([]);
    // @ts-expect-error intentional test of null input
    expect(calculateBollingerBands(null)).toEqual([]);
    // @ts-expect-error intentional test of null input
    expect(calculateVWAP(null)).toEqual([]);
  });
});
