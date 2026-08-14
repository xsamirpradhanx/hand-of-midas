import { describe, expect, it } from 'vitest';
import { calibratePrediction, learningKey } from './learningEngine.js';

describe('learningEngine', () => {
  it('uses a conservative model prior when no finalized outcomes exist', () => {
    const assessment = calibratePrediction(0.7);
    expect(assessment.calibratedProbability).toBe(0.7);
    expect(assessment.source).toBe('MODEL_PRIOR');
    expect(assessment.reliability).toBe('INSUFFICIENT');
  });

  it('shrinks a small perfect sample instead of reporting certainty', () => {
    const assessment = calibratePrediction(0.5, { wins: 2, losses: 0, tries: 2 });
    expect(assessment.calibratedProbability).toBe(0.6);
    expect(assessment.calibratedProbability).toBeLessThan(1);
  });

  it('lets a large finalized sample outweigh the model prior', () => {
    const assessment = calibratePrediction(0.4, { wins: 24, losses: 6, tries: 30 });
    expect(assessment.calibratedProbability).toBe(0.716);
    expect(assessment.reliability).toBe('ESTABLISHED');
  });

  it('keeps long and short feedback streams separate', () => {
    expect(learningKey('LONG')).toBe('GLOBAL|LONG');
    expect(learningKey('SHORT')).toBe('GLOBAL|SHORT');
  });
});
