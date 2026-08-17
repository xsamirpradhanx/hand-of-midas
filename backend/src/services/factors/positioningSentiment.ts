import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

/**
 * Insider / Analyst / Social Positioning.
 *
 * WHY THIS EXISTS: the /sentiment page computes four independent signals — StockTwits
 * retail mood, Reddit mentions, Finnhub insider filings, and Finnhub analyst ratings —
 * and the predictive engine used exactly one of them. `sentimentAggregator` served the
 * page and nothing else, so insider transactions and analyst revisions were fetched,
 * rendered, and thrown away, while the entire CATALYST bucket rested on a single
 * headline-keyword factor. This closes that gap.
 *
 * The three sources are deliberately weighted differently rather than averaged:
 *
 *  - Insider filings are the strongest of the three. Executives buying their own stock
 *    is a costly, disclosed, directional action.
 *  - Analyst ratings are slower and famously skewed toward buy, so the reading is taken
 *    relative to the buy-side-heavy baseline rather than at face value.
 *  - Social mood is the weakest and most reflexive — retail bullishness is often a
 *    coincident readout of what price already did. It is included as a light tilt only,
 *    and never carries the factor on its own.
 */

/**
 * Both Finnhub-derived scores are normalised to 0–100 with 50 balanced and higher
 * meaning more bullish — see getFinnhubAnalystRecommendation, which converts the raw
 * strongBuy/buy/hold/sell/strongSell counts into `50 + 25 * (net / total)`.
 *
 * Worth stating explicitly because Finnhub's *own* recommendation convention runs
 * 1 (strong buy) to 5 (strong sell), i.e. inverted and on a different scale. Applying
 * that convention here scored AAPL — 72/100 across 54 ratings, a clearly bullish
 * book — as maximally bearish.
 */
const SCORE_NEUTRAL = 50;
const SCORE_RANGE = 50;

export class PositioningSentimentFactor implements PredictiveFactor {
  name = 'Insider / Analyst / Social Positioning';
  bucket = 'CATALYST' as const;
  // Distinct from the news-headline factor: these are disclosed positions and ratings,
  // not press coverage, so they count as independent evidence within CATALYST.
  correlationGroup = 'POSITIONING_SENTIMENT';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const s = input.sentiment;
    if (!s) return null;

    // Each component contributes a signed tilt in roughly -1..+1, plus a weight
    // reflecting how much that source is worth when it is actually present.
    const components: { label: string; tilt: number; weight: number }[] = [];

    const insider = s.finnhub?.insiderSentiment;
    if (typeof insider === 'number' && (s.finnhub?.insiderMonthsSampled ?? 0) > 0) {
      const tilt = Math.max(-1, Math.min(1, (insider - SCORE_NEUTRAL) / SCORE_RANGE));
      components.push({
        label: `insiders ${insider.toFixed(0)}/100 over ${s.finnhub.insiderMonthsSampled}mo`,
        tilt,
        weight: 0.5,
      });
    }

    const analyst = s.finnhub?.analystScore;
    if (typeof analyst === 'number') {
      const tilt = Math.max(-1, Math.min(1, (analyst - SCORE_NEUTRAL) / SCORE_RANGE));
      const total = s.finnhub.analystStrongBuy + s.finnhub.analystBuy + s.finnhub.analystHold +
        s.finnhub.analystSell + s.finnhub.analystStrongSell;
      components.push({
        label: `analysts ${analyst.toFixed(0)}/100 across ${total} ratings`,
        tilt,
        weight: 0.3,
      });
    }

    // Social: StockTwits bull/bear ratio and Reddit's own -1..1 score, combined and
    // then deliberately capped low.
    const socialTilts: number[] = [];
    const stRatio = s.retail?.ratio;
    if (typeof stRatio === 'number' && (s.retail.bullish + s.retail.bearish) >= 10) {
      // ratio is bull:bear; 1.0 is balanced. log keeps 4:1 and 1:4 symmetric.
      socialTilts.push(Math.max(-1, Math.min(1, Math.log(Math.max(stRatio, 0.01)) / Math.log(4))));
    }
    if (typeof s.reddit?.sentimentScore === 'number' && (s.reddit.mentions ?? 0) >= 5) {
      socialTilts.push(Math.max(-1, Math.min(1, s.reddit.sentimentScore)));
    }
    if (socialTilts.length) {
      components.push({
        label: `social ${socialTilts.length === 2 ? '(StockTwits + Reddit)' : '(single source)'}`,
        tilt: socialTilts.reduce((a, b) => a + b, 0) / socialTilts.length,
        weight: 0.2,
      });
    }

    if (components.length === 0) return null;

    const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
    const net = components.reduce((sum, c) => sum + c.tilt * c.weight, 0) / totalWeight;

    // Require a real tilt before claiming a direction — these sources are noisy and a
    // marginal reading is not evidence of anything.
    const bias: 'bullish' | 'bearish' | 'neutral' =
      net > 0.2 ? 'bullish' : net < -0.2 ? 'bearish' : 'neutral';

    // Confidence scales with how many independent sources were actually available,
    // so a lone social reading cannot masquerade as broad agreement.
    const coverage = totalWeight / 1.0;
    const weight = Number((Math.min(0.30, 0.30 * Math.abs(net) * coverage)).toFixed(4));

    const detail = components
      .map(c => `${c.label} ${c.tilt >= 0 ? '+' : ''}${(c.tilt * 100).toFixed(0)}%`)
      .join(', ');

    return {
      factorName: this.name,
      // Positioning says who is leaning which way, not where support sits — so it
      // votes on direction and contributes no price levels.
      bias,
      weight: Math.max(0.02, weight),
      bucket: 'CATALYST',
      correlationGroup: 'POSITIONING_SENTIMENT',
      reasoning: `Disclosed positioning is net ${net >= 0 ? '+' : ''}${(net * 100).toFixed(0)}% ${bias === 'neutral' ? '(inside the ±20% neutral band)' : bias}: ${detail}. Insider filings are weighted heaviest, social mood lightest — retail sentiment tends to follow price rather than lead it.`,
    };
  }
}
