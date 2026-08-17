import { createChart, ColorType, IChartApi } from 'lightweight-charts';

export function createMainChart(container: HTMLElement, width: number, height: number): IChartApi {
  return createChart(container, {
    width,
    height,
    layout: {
      background: { type: ColorType.Solid, color: '#0a0e27' },
      textColor: '#e0e0e0',
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Inter", sans-serif',
    },
    grid: {
      vertLines: { color: 'rgba(43, 43, 67, 0.5)' },
      horzLines: { color: 'rgba(43, 43, 67, 0.5)' },
    },
    timeScale: {
      timeVisible: true,
      secondsVisible: false,
    },
    crosshair: {
      mode: 1, // Normal mode
    },
    localization: {
      // Always display times in US Eastern (market timezone), regardless of browser locale.
      // This ensures Schwab (UTC epoch) and Yahoo (UTC strings) both display as ET.
      timeFormatter: (time: number | string) => {
        if (typeof time === 'string') return time;
        return new Date(time * 1000).toLocaleString('en-US', {
          timeZone: 'America/New_York',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
      },
    },
  });
}


// SMA and EMA draw from separate pools so the first of each type never share
// a hue, and each pool alternates warm/cool so two of the same type added
// back-to-back (e.g. EMA 20 then EMA 50) stay visually distinct too.
const smaColors = ['#00d4aa', '#f72585', '#4cc9f0', '#ffd60a', '#b5179e'];
const emaColors = ['#fca311', '#3a86ff', '#ff006e', '#06ffa5', '#7209b7'];
const defaultColors = ['#00d4aa', '#00b4d8', '#fca311', '#e0a96d', '#9d4edd'];

export function getSeriesColor(type: string, index: number): string {
  if (type === 'SMA') return smaColors[index % smaColors.length];
  if (type === 'EMA') return emaColors[index % emaColors.length];
  return defaultColors[index % defaultColors.length];
}

export function formatVolume(volume: number): string {
  if (volume >= 1e9) return (volume / 1e9).toFixed(2) + 'B';
  if (volume >= 1e6) return (volume / 1e6).toFixed(2) + 'M';
  if (volume >= 1e3) return (volume / 1e3).toFixed(2) + 'K';
  return volume.toString();
}

export function formatPrice(price: number): string {
  return price.toFixed(2);
}
