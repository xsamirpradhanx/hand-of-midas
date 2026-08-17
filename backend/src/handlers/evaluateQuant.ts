import { evaluateQuant } from '../scripts/evaluateQuant.js';

/**
 * Scheduled entry point: grades finalized predictions against subsequent
 * price action and feeds FACTOR_STATS/SETUP_STATS, closing the feedback loop
 * that applyRegimeMultiplier's accuracy-based weighting depends on. Without
 * this running regularly, every factor stays on its neutral 1.0x multiplier
 * forever, no matter how many predictions accumulate.
 */
export async function handler(): Promise<void> {
  await evaluateQuant();
}
