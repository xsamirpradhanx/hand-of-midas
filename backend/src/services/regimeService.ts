// backend/src/services/regimeService.ts

import { yf } from './yahoo.js';

export type RegimeStatus = 'Risk-On' | 'Risk-Off' | 'Neutral' | 'High-Vol';

export interface MarketRegime {
  globalRegime: RegimeStatus;
  spyChange: number;
  qqqChange: number;
  vixChange: number;
  // TODO: Add IWM, 10Y, DXY
}

export interface SectorRegime {
  sectorTicker: string;
  isBullish: boolean;
  changePercent: number;
}

/**
 * Fetch and determine the global market regime.
 */
export async function getGlobalRegime(): Promise<MarketRegime> {
  // In a real implementation, this would fetch intraday or daily changes for major indices.
  // We'll use Yahoo Finance quote for SPY, QQQ, ^VIX as a proxy.
  
  const symbols = ['SPY', 'QQQ', '^VIX'];
  let spyChange = 0;
  let qqqChange = 0;
  let vixChange = 0;

  try {
    const quotes = await yf.quote(symbols);
    const quotesArr = Array.isArray(quotes) ? quotes : [quotes];
    
    for (const q of quotesArr) {
      const changePercent = (q['regularMarketChangePercent'] as number) ?? 0;
      if (q['symbol'] === 'SPY') spyChange = changePercent;
      if (q['symbol'] === 'QQQ') qqqChange = changePercent;
      if (q['symbol'] === '^VIX') vixChange = changePercent;
    }
  } catch (error) {
    console.error('Failed to fetch regime quotes:', error);
  }

  let globalRegime: RegimeStatus = 'Neutral';

  if (vixChange > 5) {
    globalRegime = 'High-Vol';
  } else if (spyChange > 0.5 && qqqChange > 0.5 && vixChange < 0) {
    globalRegime = 'Risk-On';
  } else if (spyChange < -0.5 && qqqChange < -0.5 && vixChange > 0) {
    globalRegime = 'Risk-Off';
  }

  return {
    globalRegime,
    spyChange,
    qqqChange,
    vixChange
  };
}

/**
 * Determine sector regime given a sector ETF ticker.
 */
export async function getSectorRegime(sectorTicker: string): Promise<SectorRegime> {
  let changePercent = 0;
  try {
    const q = await yf.quote(sectorTicker);
    if (q) {
      changePercent = (q['regularMarketChangePercent'] as number) ?? 0;
    }
  } catch (error) {
    console.warn(`Failed to fetch sector quote for ${sectorTicker}`, error);
  }

  return {
    sectorTicker,
    isBullish: changePercent > 0.5,
    changePercent
  };
}
