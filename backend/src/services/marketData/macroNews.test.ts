import { describe, it, expect } from 'vitest';
import { tagHeadline } from './macroNews.js';

/**
 * The filter's job is to keep a general business wire from filling the rates
 * page with consumer stories, without discarding the macro ones. Both failure
 * directions are silent — a too-narrow vocabulary shows an empty panel, a
 * too-loose one shows pizza — so both are asserted.
 */
describe('macro headline tagging', () => {
  it('keeps policy, geopolitical, currency and commodity stories', () => {
    expect(tagHeadline('Fed holds rates steady as inflation cools')).toContain('Policy');
    expect(tagHeadline('US, Iran keep up hostile rhetoric ahead of new sanctions')).toContain('Geopolitics');
    expect(tagHeadline('Weaker dollar revives bullion demand')).toContain('Currency');
    expect(tagHeadline('Brent crude climbs on supply fears')).toContain('Commodities');
    expect(tagHeadline('CPI comes in hotter than expected')).toContain('Data');
  });

  it('drops stories with no macro bearing', () => {
    expect(tagHeadline('38-year-old runs a mobile pizzeria out of his Smart car')).toEqual([]);
    expect(tagHeadline("How a physician with a 1 a.m. bedtime optimizes his health")).toEqual([]);
  });

  /**
   * Whole-word matching, not substring. A substring test tagged "Federated
   * Investors" as central-bank policy and "warrant" as geopolitics, which is
   * how a filter like this quietly stops filtering.
   */
  it('does not match a topic word buried inside another word', () => {
    expect(tagHeadline('Federated Investors reports quarterly earnings')).toEqual([]);
    expect(tagHeadline('Company issues warrants to employees')).toEqual([]);
    expect(tagHeadline('Goldman raises target')).not.toContain('Commodities');
  });

  it('tags emerging-market currencies, not only the majors', () => {
    // Added after a rand headline surfaced tagged Geopolitics but not Currency.
    expect(tagHeadline('South African rand hits strongest level in a year')).toContain('Currency');
    expect(tagHeadline('Turkish lira slides after central bank surprise')).toContain('Currency');
  });

  it('can carry several tags when a story spans topics', () => {
    const tags = tagHeadline('Gold rebounds as bond jitters and a weaker dollar revive demand');
    expect(tags).toContain('Currency');
    expect(tags).toContain('Commodities');
  });
});
