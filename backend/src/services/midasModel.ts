// backend/src/services/midasModel.ts

import { getGlobalRegime } from './regimeService.js';
import type { ScreenerMode } from './screenerService.js';

export interface MidasScoreResult {
  midasScore: number;
  momentumScore: number;
  riskScore: number;
  probability: number;
  subScores: {
    momentumQuality: number;
    volumeConfirmation: number;
    extensionPenalty: number;
    catalystQuality: number;
    liquidity: number;
    riskInverse: number;
  };
}

/**
 * Calculates the Midas Score (0-100), Momentum Score (0-100), and Risk Score (0-100).
 * Implements the 6-component algorithmic weighting architecture:
 * 1. Momentum Quality (20%)
 * 2. Volume Confirmation (15%)
 * 3. Extension Penalty (20%)
 * 4. Catalyst Quality (15%)
 * 5. Liquidity/Execution (10%)
 * 6. Risk/Extension Inverse (20%)
 */
export async function calculateMidasScore(
  ticker: string,
  price: number,
  changePercent: number,
  rvol: number,
  intradayRvol: number,
  setupScore: number,
  mode: ScreenerMode,
  absoluteVolume: number,
  floatTurnover?: number,
  rsi14?: number | null
): Promise<MidasScoreResult> {
  const regime = await getGlobalRegime();
  let regimeMultiplier = 1.0;
  if (regime.globalRegime === 'Risk-On') {
    regimeMultiplier = 1.05;
  } else if (regime.globalRegime === 'Risk-Off') {
    regimeMultiplier = 0.85;
  }

  const absPct = Math.abs(changePercent);

  // ── 1. Momentum Score (Standalone) ──────────────────────────────────────────
  // Pure reflection of how aggressively the stock is moving.
  // This is where a 400% gainer gets a 99.
  let rawMomentum = (absPct * 1.5) + (intradayRvol * 2);
  const momentumScore = Math.min(99, Math.max(1, Math.round(rawMomentum)));

  // ── 2. Risk Score (Standalone) ──────────────────────────────────────────────
  // Probability of adverse conditions, halts, or being trapped at the top.
  let riskRaw = 0;
  
  if (absPct > 200) riskRaw += 60;
  else if (absPct > 100) riskRaw += 40;
  else if (absPct > 50) riskRaw += 25;
  else if (absPct > 20) riskRaw += 10;

  if (floatTurnover !== undefined) {
    if (floatTurnover > 10) riskRaw += 30;
    else if (floatTurnover > 3) riskRaw += 15;
    else if (floatTurnover > 1) riskRaw += 5;
  }
  
  if (absoluteVolume < 100_000) riskRaw += 20;

  if (price < 1) riskRaw += 20;
  else if (price < 5) riskRaw += 10;

  if (rsi14 && rsi14 > 85) riskRaw += 15;

  const riskScore = Math.min(99, Math.max(1, Math.round(riskRaw)));
  const riskInverse = 100 - riskScore;

  // ── 3. Component 1: Momentum Quality (20%) ─────────────────────────────────
  // Non-linear reward. A 150% move shouldn't be 10x better than a 15% move.
  let momentumQuality = 0;
  if (absPct >= 25 && absPct <= 50) momentumQuality = 100; // Very strong sweet spot
  else if (absPct > 50 && absPct <= 100) momentumQuality = 80; // Diminishing
  else if (absPct > 100) momentumQuality = 40; // Heavily diminishing (likely too late)
  else if (absPct >= 10 && absPct < 25) momentumQuality = 80;
  else if (absPct > 0) momentumQuality = 50;

  // ── 4. Component 2: Volume Confirmation (15%) ──────────────────────────────
  // Cap RVOL to prevent absurd values from saturating the model.
  let volumeConfirmation = 0;
  if (intradayRvol >= 10 && intradayRvol <= 25) volumeConfirmation = 100; // Excellent
  else if (intradayRvol > 25 && intradayRvol <= 50) volumeConfirmation = 80; // Exceptional but dangerous
  else if (intradayRvol > 50) volumeConfirmation = 50; // Capped/penalized (anomaly risk)
  else if (intradayRvol >= 5 && intradayRvol < 10) volumeConfirmation = 80;
  else if (intradayRvol >= 2 && intradayRvol < 5) volumeConfirmation = 60;
  else if (intradayRvol > 0) volumeConfirmation = 30;

  // ── 5. Component 3: Extension Penalty (20%) ────────────────────────────────
  // Punish setups that are already blown out.
  let extensionPenaltyScore = 100;
  if (absPct > 50) extensionPenaltyScore -= 40;
  else if (absPct > 30) extensionPenaltyScore -= 20;
  else if (absPct > 20) extensionPenaltyScore -= 10;
  
  if (rsi14) {
    if (rsi14 > 80) extensionPenaltyScore -= 30;
    else if (rsi14 > 70) extensionPenaltyScore -= 15;
  }
  extensionPenaltyScore = Math.max(0, extensionPenaltyScore);

  // ── 6. Component 4: Catalyst Quality (15%) ─────────────────────────────────
  const catalystQuality = Math.min(100, Math.max(0, setupScore));

  // ── 7. Component 5: Liquidity/Execution (10%) ──────────────────────────────
  let liquidity = 100;
  if (absoluteVolume < 200_000) liquidity = 20;
  else if (absoluteVolume < 500_000) liquidity = 50;
  else if (absoluteVolume < 1_000_000) liquidity = 75;

  // ── 8. Midas Score Calculation ─────────────────────────────────────────────
  // Midas Score = Probability / Quality of Setup
  const rawMidas = 
    (momentumQuality * 0.20) +
    (volumeConfirmation * 0.15) +
    (extensionPenaltyScore * 0.20) +
    (catalystQuality * 0.15) +
    (liquidity * 0.10) +
    (riskInverse * 0.20);

  // Premarket setups naturally have less confirmation, slight handicap adjust
  let adjustedMidas = rawMidas;
  if (mode === 'premarket') adjustedMidas += 5;

  const midasScore = Math.min(99, Math.max(1, Math.round(adjustedMidas * regimeMultiplier)));
  
  // Max expressible win-probability is 75%
  const probability = Math.min(75, Math.round(midasScore * 0.75));

  return { 
    midasScore, 
    momentumScore,
    riskScore,
    probability,
    subScores: {
      momentumQuality,
      volumeConfirmation,
      extensionPenalty: extensionPenaltyScore,
      catalystQuality,
      liquidity,
      riskInverse
    }
  };
}
