/**
 * Heikin-Ashi candlestick transformation.
 *
 * Converts raw OHLCV bars into smoothed Heikin-Ashi candles using:
 *   HA_Close = (O + H + L + C) / 4
 *   HA_Open  = (prev_HA_Open + prev_HA_Close) / 2  (first bar seeds from raw O)
 *   HA_High  = max(H, HA_Open, HA_Close)
 *   HA_Low   = min(L, HA_Open, HA_Close)
 */

export interface HeikinAshiBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export function calculateHeikinAshi(
  data: { time: string; open: number; high: number; low: number; close: number }[]
): HeikinAshiBar[] {
  if (!data || data.length === 0) return [];

  const result: HeikinAshiBar[] = [];

  for (let i = 0; i < data.length; i++) {
    const bar = data[i];
    const haClose = (bar.open + bar.high + bar.low + bar.close) / 4;

    let haOpen: number;
    if (i === 0) {
      haOpen = (bar.open + bar.close) / 2;
    } else {
      const prev = result[i - 1];
      haOpen = (prev.open + prev.close) / 2;
    }

    const haHigh = Math.max(bar.high, haOpen, haClose);
    const haLow = Math.min(bar.low, haOpen, haClose);

    result.push({ time: bar.time, open: haOpen, high: haHigh, low: haLow, close: haClose });
  }

  return result;
}
