import { describe, it, expect } from 'vitest';
import { realizedDirection, factorWasCorrect } from './factorAttribution.js';

describe('realizedDirection', () => {
  it('maps every plan/outcome pair to the move that actually happened', () => {
    expect(realizedDirection('LONG', 'TARGET')).toBe('up');
    expect(realizedDirection('LONG', 'STOP')).toBe('down');
    expect(realizedDirection('SHORT', 'TARGET')).toBe('down');
    expect(realizedDirection('SHORT', 'STOP')).toBe('up');
    expect(realizedDirection('BEARISH', 'TARGET')).toBe('down');
  });

  it('refuses to infer a direction it cannot know', () => {
    // Both levels touched in one bar; OHLC cannot order them.
    expect(realizedDirection('LONG', 'AMBIGUOUS')).toBeNull();
    // Neither level reached.
    expect(realizedDirection('LONG', 'TIMEOUT')).toBeNull();
  });
});

describe('factorWasCorrect', () => {
  it('credits a factor only when its own vote matched the move', () => {
    expect(factorWasCorrect('bullish', 'up')).toBe(true);
    expect(factorWasCorrect('bullish', 'down')).toBe(false);
    expect(factorWasCorrect('bearish', 'down')).toBe(true);
    expect(factorWasCorrect('bearish', 'up')).toBe(false);
  });

  it('treats neutral as an abstention, not a loss', () => {
    expect(factorWasCorrect('neutral', 'up')).toBeNull();
    expect(factorWasCorrect(undefined, 'down')).toBeNull();
  });

  it('separates two factors that disagreed on the same trade', () => {
    // The regression this module exists to prevent: on one losing LONG, the
    // bullish factor was wrong and the bearish factor was right. The old code
    // charged both with the same loss.
    const realized = realizedDirection('LONG', 'STOP')!;
    expect(factorWasCorrect('bullish', realized)).toBe(false);
    expect(factorWasCorrect('bearish', realized)).toBe(true);
  });
});
