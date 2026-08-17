import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../services/schwabService.js', () => ({
  getPriceHistorySchwab: vi.fn(),
}));
vi.mock('../../services/yahoo.js', () => ({
  yf: { chart: vi.fn() },
}));
vi.mock('../../services/cache.js', () => ({
  getCachedData: vi.fn(),
  setCachedData: vi.fn().mockResolvedValue(undefined),
  timeSeriesCacheKey: (sym: string, interval: string, ext: boolean) =>
    `CACHE#${sym}#${interval}${ext ? '#EXT' : ''}`,
}));

import { getPriceHistorySchwab } from '../../services/schwabService.js';
import { yf } from '../../services/yahoo.js';
import { getCachedData, setCachedData } from '../../services/cache.js';
import { fetchBarsWithFallback } from '../../services/marketData/fetchBars.js';

const schwabBar = (ts: number, close: number) => ({
  timestamp: ts,
  open: close - 0.5,
  high: close + 0.5,
  low: close - 1,
  close,
  volume: 1000,
});

const yahooBar = (iso: string, close: number) => ({
  date: new Date(iso),
  open: close - 0.5,
  high: close + 0.5,
  low: close - 1,
  close,
  volume: 2000,
});

describe('fetchBarsWithFallback', () => {
  beforeEach(() => {
    vi.mocked(getCachedData).mockReset().mockResolvedValue(null);
    vi.mocked(setCachedData).mockReset().mockResolvedValue(undefined);
    vi.mocked(getPriceHistorySchwab).mockReset();
    vi.mocked(yf.chart).mockReset();
  });

  it('returns Schwab bars normalized to OHLCVDataPoint when Schwab succeeds', async () => {
    const t0 = Date.parse('2026-08-14T13:30:00Z');
    vi.mocked(getPriceHistorySchwab).mockResolvedValue([
      schwabBar(t0, 100),
      schwabBar(t0 + 60_000, 101),
    ]);

    const res = await fetchBarsWithFallback('AAPL', '5min', 10);

    expect(res.provider).toBe('schwab');
    expect(res.source).toBe('schwab');
    expect(res.bars).toHaveLength(2);
    expect(res.bars[0]).toEqual({
      datetime: new Date(t0).toISOString(),
      open: 99.5,
      high: 100.5,
      low: 99,
      close: 100,
      volume: 1000,
    });
    expect(yf.chart).not.toHaveBeenCalled();
  });

  it('falls back to Yahoo when Schwab throws', async () => {
    vi.mocked(getPriceHistorySchwab).mockRejectedValue(new Error('Schwab 401'));
    vi.mocked(yf.chart).mockResolvedValue({
      quotes: [yahooBar('2026-08-14T13:30:00Z', 100)],
    } as any);

    const res = await fetchBarsWithFallback('AAPL', '5min', 10);

    expect(res.provider).toBe('yahoo');
    expect(res.source).toBe('yahoo');
    expect(res.bars).toHaveLength(1);
    expect(res.bars[0].close).toBe(100);
    expect(res.bars[0].volume).toBe(2000);
  });

  it('falls back to Yahoo when Schwab returns an empty array', async () => {
    vi.mocked(getPriceHistorySchwab).mockResolvedValue([]);
    vi.mocked(yf.chart).mockResolvedValue({
      quotes: [yahooBar('2026-08-14T13:30:00Z', 42)],
    } as any);

    const res = await fetchBarsWithFallback('AAPL', '1day', 10);

    expect(res.provider).toBe('yahoo');
    expect(res.bars).toHaveLength(1);
    expect(res.bars[0].close).toBe(42);
  });

  it('respects preferredProvider=yahoo (skips Schwab when Yahoo succeeds)', async () => {
    vi.mocked(yf.chart).mockResolvedValue({
      quotes: [yahooBar('2026-08-14T13:30:00Z', 55)],
    } as any);

    const res = await fetchBarsWithFallback('AAPL', '15min', 10, {
      preferredProvider: 'yahoo',
    });

    expect(res.provider).toBe('yahoo');
    expect(getPriceHistorySchwab).not.toHaveBeenCalled();
  });

  it('returns cached bars without hitting either provider', async () => {
    vi.mocked(getCachedData).mockResolvedValue({
      bars: [
        {
          datetime: '2026-08-14T13:30:00.000Z',
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          volume: 1,
        },
      ],
      provider: 'schwab',
    });

    const res = await fetchBarsWithFallback('AAPL', '1day', 10);

    expect(res.source).toBe('cache');
    expect(res.provider).toBe('schwab');
    expect(getPriceHistorySchwab).not.toHaveBeenCalled();
    expect(yf.chart).not.toHaveBeenCalled();
  });

  it('skips the cache when useCache=false and writes fresh data back', async () => {
    const t0 = Date.parse('2026-08-14T13:30:00Z');
    vi.mocked(getPriceHistorySchwab).mockResolvedValue([schwabBar(t0, 100)]);

    await fetchBarsWithFallback('AAPL', '5min', 10, { useCache: false });

    expect(getCachedData).not.toHaveBeenCalled();
    expect(setCachedData).not.toHaveBeenCalled();
  });

  it('caps the returned bars to the requested count (most recent)', async () => {
    const t0 = Date.parse('2026-08-14T13:30:00Z');
    const many = Array.from({ length: 10 }, (_, i) =>
      schwabBar(t0 + i * 60_000, 100 + i),
    );
    vi.mocked(getPriceHistorySchwab).mockResolvedValue(many);

    const res = await fetchBarsWithFallback('AAPL', '1min', 3);

    expect(res.bars).toHaveLength(3);
    expect(res.bars.map((b) => b.close)).toEqual([107, 108, 109]);
  });

  it('propagates a hard error if both providers fail', async () => {
    vi.mocked(getPriceHistorySchwab).mockRejectedValue(new Error('Schwab down'));
    vi.mocked(yf.chart).mockRejectedValue(new Error('Yahoo down'));

    await expect(fetchBarsWithFallback('AAPL', '1day', 10)).rejects.toThrow(
      /Failed to fetch bars for AAPL/,
    );
  });

  it('rejects invalid count', async () => {
    await expect(fetchBarsWithFallback('AAPL', '1day', 0)).rejects.toThrow(/count/);
    await expect(fetchBarsWithFallback('AAPL', '1day', -5)).rejects.toThrow(/count/);
  });
});
