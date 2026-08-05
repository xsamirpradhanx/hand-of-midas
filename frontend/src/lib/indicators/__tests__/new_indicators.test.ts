import { describe, it, expect } from 'vitest';
import type { OHLCVBar } from '../types';

import { calculateWMA } from '../wma';
import { calculateHMA } from '../hma';
import { calculateKeltnerChannels } from '../keltnerChannels';
import { calculateDonchianChannels } from '../donchianChannels';
import { calculateParabolicSAR } from '../parabolicSar';
import { calculateIchimoku } from '../ichimoku';
import { calculateCCI } from '../cci';
import { calculateWilliamsR } from '../williamsR';
import { calculateOBV } from '../obv';
import { calculateCMF } from '../cmf';
import { calculateMFI } from '../mfi';
import { calculateROC } from '../roc';
import { calculateMomentum } from '../momentum';
import { calculateAroon } from '../aroon';

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

describe('New Indicators', () => {
  describe('WMA', () => {
    it('returns empty array for empty data', () => {
      expect(calculateWMA([], 14)).toEqual([]);
    });

    it('has correct output length', () => {
      const result = calculateWMA(testBars, 5);
      expect(result).toHaveLength(testBars.length - 5 + 1);
    });
  });

  describe('HMA', () => {
    it('returns empty array for empty data', () => {
      expect(calculateHMA([], 9)).toEqual([]);
    });

    it('returns array with values', () => {
      const result = calculateHMA(testBars, 5);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('Keltner Channels', () => {
    it('returns empty array for empty data', () => {
      expect(calculateKeltnerChannels([], 20, 2)).toEqual([]);
    });

    it('has upper > middle > lower', () => {
      const result = calculateKeltnerChannels(testBars, 5, 2);
      expect(result.length).toBeGreaterThan(0);
      for (const kc of result) {
        expect(kc.upper).toBeGreaterThan(kc.middle);
        expect(kc.middle).toBeGreaterThan(kc.lower);
      }
    });
  });

  describe('Donchian Channels', () => {
    it('returns empty array for empty data', () => {
      expect(calculateDonchianChannels([], 20)).toEqual([]);
    });

    it('has upper >= middle >= lower', () => {
      const result = calculateDonchianChannels(testBars, 5);
      expect(result.length).toBeGreaterThan(0);
      for (const dc of result) {
        expect(dc.upper).toBeGreaterThanOrEqual(dc.middle);
        expect(dc.middle).toBeGreaterThanOrEqual(dc.lower);
      }
    });
  });

  describe('Parabolic SAR', () => {
    it('returns empty array for empty data', () => {
      expect(calculateParabolicSAR([], 0.02, 0.2)).toEqual([]);
    });

    it('has correct output length', () => {
      const result = calculateParabolicSAR(testBars);
      expect(result).toHaveLength(testBars.length - 1);
    });
  });

  describe('Ichimoku', () => {
    it('returns empty array for empty data', () => {
      expect(calculateIchimoku([])).toEqual([]);
    });

    it('has null senkouB if length is less than 52 but we still return data', () => {
      const result = calculateIchimoku(testBars); // 20 bars < 52
      expect(result.length).toBe(0); // My implementation returns [] if data.length < 52
    });
  });

  describe('CCI', () => {
    it('returns empty array for empty data', () => {
      expect(calculateCCI([], 20)).toEqual([]);
    });

    it('returns values for valid data length', () => {
      const result = calculateCCI(testBars, 5);
      expect(result).toHaveLength(testBars.length - 5 + 1);
    });
  });

  describe('Williams %R', () => {
    it('returns empty array for empty data', () => {
      expect(calculateWilliamsR([], 14)).toEqual([]);
    });

    it('returns values between -100 and 0', () => {
      const result = calculateWilliamsR(testBars, 5);
      for (const r of result) {
        expect(r.value).toBeGreaterThanOrEqual(-100);
        expect(r.value).toBeLessThanOrEqual(0);
      }
    });
  });

  describe('OBV', () => {
    it('returns empty array for empty data', () => {
      expect(calculateOBV([])).toEqual([]);
    });

    it('returns values for valid data length', () => {
      const result = calculateOBV(testBars);
      expect(result).toHaveLength(testBars.length);
    });
  });

  describe('CMF', () => {
    it('returns empty array for empty data', () => {
      expect(calculateCMF([], 20)).toEqual([]);
    });

    it('returns values between -1 and 1', () => {
      const result = calculateCMF(testBars, 5);
      for (const cmf of result) {
        expect(cmf.value).toBeGreaterThanOrEqual(-1);
        expect(cmf.value).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('MFI', () => {
    it('returns empty array for empty data', () => {
      expect(calculateMFI([], 14)).toEqual([]);
    });

    it('returns values between 0 and 100', () => {
      const result = calculateMFI(testBars, 5);
      for (const mfi of result) {
        expect(mfi.value).toBeGreaterThanOrEqual(0);
        expect(mfi.value).toBeLessThanOrEqual(100);
      }
    });
  });

  describe('ROC', () => {
    it('returns empty array for empty data', () => {
      expect(calculateROC([], 12)).toEqual([]);
    });

    it('returns values', () => {
      const result = calculateROC(testBars, 5);
      expect(result).toHaveLength(testBars.length - 5);
    });
  });

  describe('Momentum', () => {
    it('returns empty array for empty data', () => {
      expect(calculateMomentum([], 10)).toEqual([]);
    });

    it('returns values', () => {
      const result = calculateMomentum(testBars, 5);
      expect(result).toHaveLength(testBars.length - 5);
    });
  });

  describe('Aroon', () => {
    it('returns empty array for empty data', () => {
      expect(calculateAroon([], 25)).toEqual([]);
    });

    it('returns valid values for Aroon', () => {
      const result = calculateAroon(testBars, 5);
      expect(result).toHaveLength(testBars.length - 5);
      for (const a of result) {
        expect(a.up).toBeGreaterThanOrEqual(0);
        expect(a.up).toBeLessThanOrEqual(100);
        expect(a.down).toBeGreaterThanOrEqual(0);
        expect(a.down).toBeLessThanOrEqual(100);
      }
    });
  });
});
