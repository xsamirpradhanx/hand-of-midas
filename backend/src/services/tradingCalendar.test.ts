import { describe, expect, it } from 'vitest';
import { getMarketSession } from './tradingCalendar.js';

describe('getMarketSession', () => {
  it('uses Eastern time rather than the Lambda host timezone', () => {
    expect(getMarketSession(new Date('2026-08-13T18:30:00Z'))).toBe('REGULAR'); // 2:30 PM EDT
  });

  it('identifies the premarket window only through 9:30 AM ET', () => {
    expect(getMarketSession(new Date('2026-08-13T12:00:00Z'))).toBe('PREMARKET'); // 8:00 AM EDT
    expect(getMarketSession(new Date('2026-08-13T13:30:00Z'))).toBe('REGULAR'); // 9:30 AM EDT
  });
});
