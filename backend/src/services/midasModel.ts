import { getGlobalRegime } from './regimeService.js';
import type { ScreenerMode } from './screenerService.js';

export interface MidasScoreResult {
  midasScore: number;
  longMomentum: number;
  shortMomentum: number;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
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
  rsi14?: number | null,
  volumeAcceleration?: number
): Promise<MidasScoreResult> {
  const regime = await getGlobalRegime();
  let regimeMultiplier = 1.0;
  if (regime.globalRegime === 'Risk-On') {
    regimeMultiplier = 1.05;
  } else if (regime.globalRegime === 'Risk-Off') {
    regimeMultiplier = 0.85;
  }

  const absPct = Math.abs(changePercent);

  // ── 1. Direction & Momentum Scoring ───────────────────────────────────────
  // Volume leads price: when intradayRvol is very high (>5x), even a small
  // price move (±0.5%) is a strong directional signal — institutional flow
  // has begun before the price move materializes.
  let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  let longMomentum = 0;
  let shortMomentum = 0;

  const directionThreshold = intradayRvol > 5 ? 0.5 : 2;

  if (changePercent > directionThreshold) {
    direction = 'LONG';
    longMomentum = Math.min(99, Math.max(1, Math.round((absPct * 1.5) + (intradayRvol * 2))));
  } else if (changePercent < -directionThreshold) {
    direction = 'SHORT';
    shortMomentum = Math.min(99, Math.max(1, Math.round((absPct * 1.5) + (intradayRvol * 2))));
  } else {
    // Within threshold zone — use volume to detect direction
    if (intradayRvol > 3 && changePercent > 0) direction = 'LONG';
    if (intradayRvol > 3 && changePercent < 0) direction = 'SHORT';
    longMomentum = Math.min(99, Math.max(1, Math.round((Math.max(0, changePercent) * 1.5) + (intradayRvol * 1.5))));
    shortMomentum = Math.min(99, Math.max(1, Math.round((Math.max(0, -changePercent) * 1.5) + (intradayRvol * 1.5))));
  }

  // ── 2. Risk Score ────────────────────────────────────────────────────────
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

  if (rsi14) {
    if (direction === 'LONG' && rsi14 > 85) riskRaw += 15;
    if (direction === 'SHORT' && rsi14 < 15) riskRaw += 15;
  }

  const riskScore = Math.min(99, Math.max(1, Math.round(riskRaw)));
  const riskInverse = 100 - riskScore;

  // ── 3. Component 1: Momentum Quality (15%) ───────────────────────────────
  // "Coiled Spring" detection: high volume with low price move = institutional
  // accumulation/distribution before the big move. This is the earliest signal.
  let momentumQuality = 0;
  const isCoiledSpring = intradayRvol > 5 && absPct < 3;

  if (isCoiledSpring) {
    // Massive volume with minimal price movement — institutional entry detected.
    // Scale score by intradayRvol intensity.
    momentumQuality = Math.min(100, 85 + Math.floor(intradayRvol / 5));
  } else if (absPct >= 15 && absPct <= 50) momentumQuality = 100; // Strong sweet spot
  else if (absPct > 50 && absPct <= 100) momentumQuality = 80;
  else if (absPct > 100) momentumQuality = 40;
  else if (absPct >= 8 && absPct < 15) momentumQuality = 80;
  else if (absPct >= 4 && absPct < 8) momentumQuality = 65;
  else if (absPct > 0) momentumQuality = 40;

  // ── 4. Component 2: Volume Confirmation (20%) ────────────────────────────
  let volumeConfirmation = 0;
  if (intradayRvol >= 10 && intradayRvol <= 35) volumeConfirmation = 100;
  else if (intradayRvol > 35 && intradayRvol <= 60) volumeConfirmation = 80;
  else if (intradayRvol > 60) volumeConfirmation = 40; // Too high, suspicious or exhausted
  else if (intradayRvol >= 5 && intradayRvol < 10) volumeConfirmation = 80;
  else if (intradayRvol >= 2 && intradayRvol < 5) volumeConfirmation = 60;
  else if (intradayRvol >= 1 && intradayRvol < 2) volumeConfirmation = 40;
  else if (intradayRvol > 0) volumeConfirmation = 20;

  // ── 5. Component 3: Extension Penalty (15%) ──────────────────────────────
  let extensionPenaltyScore = 100;
  if (absPct > 70) extensionPenaltyScore -= 40;
  else if (absPct > 40) extensionPenaltyScore -= 20;
  else if (absPct > 25) extensionPenaltyScore -= 10;
  
  if (rsi14) {
    if (direction === 'LONG' && rsi14 > 80) extensionPenaltyScore -= 30;
    else if (direction === 'LONG' && rsi14 > 70) extensionPenaltyScore -= 15;
    else if (direction === 'SHORT' && rsi14 < 20) extensionPenaltyScore -= 30;
    else if (direction === 'SHORT' && rsi14 < 30) extensionPenaltyScore -= 15;
  }
  extensionPenaltyScore = Math.max(0, extensionPenaltyScore);

  // ── 6. Component 4: Catalyst Quality (15%) ───────────────────────────────
  const catalystQuality = Math.min(100, Math.max(0, setupScore));

  // ── 7. Component 5: Liquidity/Execution (10%) ────────────────────────────
  let liquidity = 100;
  if (absoluteVolume < 200_000) liquidity = 20;
  else if (absoluteVolume < 500_000) liquidity = 50;
  else if (absoluteVolume < 1_000_000) liquidity = 75;

  // ── 8. Component 6: Volume Acceleration (10%) ────────────────────────────
  // Measures whether volume is accelerating *right now* — the earliest
  // possible signal of institutional entry. Values > 3 = significant burst.
  const volAccel = volumeAcceleration ?? 0;
  let volumeAccelerationScore = 0;
  if (volAccel >= 5) volumeAccelerationScore = 100;
  else if (volAccel >= 3) volumeAccelerationScore = 85;
  else if (volAccel >= 2) volumeAccelerationScore = 65;
  else if (volAccel >= 1.5) volumeAccelerationScore = 45;
  else if (volAccel > 0) volumeAccelerationScore = 20;

  // ── 9. Midas Score Calculation (Setup Quality) ───────────────────────────
  // Rebalanced weights to prioritize leading indicators (volume) over
  // lagging indicators (price movement / extension):
  //   Momentum Quality:     15%  (was 20%)
  //   Volume Confirmation:  20%  (was 15%) — leading signal
  //   Extension Penalty:    15%  (was 20%)
  //   Catalyst Quality:     15%  (unchanged)
  //   Liquidity:            10%  (unchanged)
  //   Risk Inverse:         15%  (was 20%)
  //   Volume Acceleration:  10%  (NEW) — earliest possible signal
  const rawMidas = 
    (momentumQuality * 0.15) +
    (volumeConfirmation * 0.20) +
    (extensionPenaltyScore * 0.15) +
    (catalystQuality * 0.15) +
    (liquidity * 0.10) +
    (riskInverse * 0.15) +
    (volumeAccelerationScore * 0.10);

  let adjustedMidas = rawMidas;
  if (mode === 'premarket') adjustedMidas += 5; // Handicap

  const midasScore = Math.min(99, Math.max(1, Math.round(adjustedMidas * regimeMultiplier)));
  const probability = Math.min(75, Math.round(midasScore * 0.75));

  return { 
    midasScore, 
    longMomentum,
    shortMomentum,
    direction,
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
