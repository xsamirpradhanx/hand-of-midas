/**
 * EventRiskEngine
 *
 * Centralizes event risk evaluation into one authoritative source.
 * Previously this was a one-liner in screenerService.ts:
 *   if (volumeAcceleration > 5 && insider?.bias !== 'neutral') eventRisk = 'HIGH';
 *
 * Now exposes structured reasons so the UI can explain WHY a setup is HIGH/MEDIUM risk.
 */

import type { FactorResult } from '../factors/types.js';

export type EventRiskLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export interface EventRisk {
  level: EventRiskLevel;
  reasons: string[];
  hasLargeVolumeAnomaly: boolean;
  hasCatalystNews: boolean;
  hasHighRvol: boolean;
}

export interface EventRiskInput {
  symbol: string;
  rvol: number;
  intradayRvol: number;
  changePercent: number;
  volumeAcceleration?: number;
  newsCount?: number;        // Number of news articles from Polygon
  insiderFactor?: FactorResult | null;
}

export function evaluateEventRisk(input: EventRiskInput): EventRisk {
  const { rvol, intradayRvol, changePercent, volumeAcceleration = 0, newsCount = 0, insiderFactor } = input;

  const reasons: string[] = [];
  let score = 0;

  // ── 1. Large price move without clear structural reason ───────────────────
  const hasLargeVolumeAnomaly = intradayRvol > 50 || Math.abs(changePercent) > 100;
  if (hasLargeVolumeAnomaly) {
    reasons.push(`Extreme mover: ${changePercent > 0 ? '+' : ''}${changePercent.toFixed(1)}% on ${intradayRvol.toFixed(0)}x intraday RVOL`);
    score += 3;
  } else if (intradayRvol > 20 || Math.abs(changePercent) > 30) {
    reasons.push(`High volatility: ${Math.abs(changePercent).toFixed(1)}% on ${intradayRvol.toFixed(0)}x RVOL`);
    score += 2;
  }

  // ── 2. Volume acceleration burst (unusual sudden flow) ─────────────────────
  if (volumeAcceleration > 8) {
    reasons.push(`Volume acceleration: ${volumeAcceleration.toFixed(1)}x (unusual burst — possible halt/news)`);
    score += 2;
  } else if (volumeAcceleration > 5) {
    reasons.push(`Volume acceleration: ${volumeAcceleration.toFixed(1)}x`);
    score += 1;
  }

  // ── 3. Catalyst / News signal ──────────────────────────────────────────────
  const hasCatalystNews = !!(insiderFactor && insiderFactor.bias !== 'neutral');
  if (hasCatalystNews) {
    const direction = insiderFactor!.bias === 'bullish' ? 'bullish catalyst' : 'bearish catalyst';
    reasons.push(`News NLP: ${direction} detected (${newsCount} articles)`);
    score += 1;
  } else if (newsCount > 10) {
    reasons.push(`High news volume: ${newsCount} articles (unconfirmed catalyst)`);
    score += 1;
  }

  // ── 4. RVOL vs baseline ────────────────────────────────────────────────────
  const hasHighRvol = rvol > 10;
  if (rvol > 15) {
    reasons.push(`RVOL ${rvol.toFixed(1)}x vs 20-day average`);
    score += 1;
  }

  // ── Classify ──────────────────────────────────────────────────────────────
  let level: EventRiskLevel;
  if (score >= 4) level = 'HIGH';
  else if (score >= 2) level = 'MEDIUM';
  else if (score >= 1) level = 'LOW';
  else level = 'NONE';

  return {
    level,
    reasons,
    hasLargeVolumeAnomaly,
    hasCatalystNews,
    hasHighRvol,
  };
}
