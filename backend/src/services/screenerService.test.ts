import { describe, it, expect } from 'vitest';
import { calculateIntradayMetrics } from './screenerService.js';

/**
 * Bars are built in ET and converted to the UTC instants yahoo-finance2 hands
 * back, so these exercise the same timezone path production does.
 * 2026-08-19 is a Wednesday; EDT is UTC-4.
 */
function etBar(etDate: string, etHour: number, etMinute: number, price: number, volume: number) {
  return {
    date: new Date(`${etDate}T${String(etHour).padStart(2, '0')}:${String(etMinute).padStart(2, '0')}:00-04:00`),
    open: price, high: price, low: price, close: price, volume,
  };
}

describe('calculateIntradayMetrics', () => {
  it('ignores the prior session entirely', () => {
    const chart = {
      quotes: [
        // Prior session — a heavy regular day that must not leak forward.
        etBar('2026-08-18', 9, 30, 100, 5_000_000),
        etBar('2026-08-18', 15, 59, 100, 5_000_000),
        // Today's pre-market.
        etBar('2026-08-19', 8, 0, 50, 1_000),
        etBar('2026-08-19', 9, 0, 50, 1_000),
      ],
    };

    const m = calculateIntradayMetrics(chart);

    expect(m.premarketVolume).toBe(2_000);
    expect(m.regularVolume).toBe(0);
    // Yesterday's $100 prints would drag a two-day VWAP to ~$100.
    expect(m.pmVwap).toBeCloseTo(50, 6);
    expect(m.pmHigh).toBe(50);
    expect(m.pmLow).toBe(50);
  });

  it('splits pre-market and regular volume at 09:30 ET', () => {
    const chart = {
      quotes: [
        etBar('2026-08-19', 4, 0, 10, 100),
        etBar('2026-08-19', 9, 29, 10, 100),
        etBar('2026-08-19', 9, 30, 10, 7),   // first regular bar
        etBar('2026-08-19', 10, 0, 10, 3),
      ],
    };

    const m = calculateIntradayMetrics(chart);

    expect(m.premarketVolume).toBe(200);
    expect(m.regularVolume).toBe(10);
  });

  it('keeps pmHigh/pmLow pre-market-only once the session is under way', () => {
    const chart = {
      quotes: [
        etBar('2026-08-19', 8, 0, 20, 100),   // PM low
        etBar('2026-08-19', 9, 0, 24, 100),   // PM high
        etBar('2026-08-19', 10, 0, 99, 100),  // regular-session spike
        etBar('2026-08-19', 11, 0, 5, 100),   // regular-session flush
      ],
    };

    const m = calculateIntradayMetrics(chart);

    expect(m.pmHigh).toBe(24);
    expect(m.pmLow).toBe(20);
  });

  it('anchors VWAP at the pre-market open, spanning both sessions', () => {
    const chart = {
      quotes: [
        etBar('2026-08-19', 8, 0, 10, 100),
        etBar('2026-08-19', 10, 0, 20, 100),
      ],
    };

    expect(calculateIntradayMetrics(chart).pmVwap).toBeCloseTo(15, 6);
  });

  it('reports the last real session when the newest bars are days old', () => {
    // Scan over a weekend/holiday: the 2-day fetch returns only Friday.
    const chart = {
      quotes: [
        etBar('2026-08-14', 9, 30, 30, 400),
        etBar('2026-08-14', 10, 0, 30, 600),
      ],
    };

    const m = calculateIntradayMetrics(chart);

    expect(m.regularVolume).toBe(1_000);
    expect(m.pmVwap).toBeCloseTo(30, 6);
  });

  it('returns empty metrics rather than NaN for unusable input', () => {
    expect(calculateIntradayMetrics(undefined)).toMatchObject({ pmVwap: null, premarketVolume: 0, regularVolume: 0 });
    expect(calculateIntradayMetrics({ quotes: [] })).toMatchObject({ pmVwap: null, regularVolume: 0 });
    expect(
      calculateIntradayMetrics({ quotes: [{ date: new Date(), close: null, volume: null }] }),
    ).toMatchObject({ pmVwap: null, pmHigh: null, premarketVolume: 0 });
  });
});
