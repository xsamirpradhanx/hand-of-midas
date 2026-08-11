// backend/src/services/universeService.ts

/**
 * Service to manage the dynamic universe of equities and ETFs.
 * Pulls the current constituents from various Yahoo Finance screeners,
 * tracks which screeners nominated each ticker, and computes a Yahoo Consensus Score.
 */

/** A ticker nominated by one or more Yahoo Finance screeners. */
export interface UniverseCandidate {
  symbol: string;
  /** Which Yahoo screener lists this ticker appeared in */
  yahooSources: string[];
  /**
   * Yahoo Consensus Score (0–100).
   * Reflects how many independent Yahoo screener lists flagged this ticker.
   * Higher = broader market agreement across different quant criteria.
   */
  yahooConsensus: number;
}

// Essential ETFs required for market-internal calculations (relative strength, regime detection).
// These are injected regardless of whether they appear in any screener list.
const ESSENTIAL_ETFS = [
  'SPY', 'QQQ', 'IWM', 'DIA', 'VIXY', 'TLT', 'GLD', 'USO',
  'XLF', 'XLK', 'XLV', 'XLE', 'XLY', 'XLI', 'XLP', 'XLU', 'XLB', 'XLRE'
];

/**
 * Compute a Yahoo Consensus Score from the number of lists nominating a ticker.
 * Non-linear: each additional list nomination carries diminishing marginal signal.
 */
function computeYahooConsensus(numSources: number): number {
  if (numSources >= 6) return 100;
  if (numSources === 5) return 90;
  if (numSources === 4) return 78;
  if (numSources === 3) return 62;
  if (numSources === 2) return 44;
  return 20; // 1 list
}

/**
 * Build the active market universe by concurrently fetching all Yahoo Finance
 * predefined screener lists, tracking which lists nominated each ticker,
 * and computing a Yahoo Consensus Score.
 */
export async function buildActiveMarketUniverse(): Promise<UniverseCandidate[]> {
  // symbol → set of screener IDs that nominated it
  const nominationMap = new Map<string, Set<string>>();
  const limit = 250; // Yahoo API returns 400 Bad Request if count > 250

  const fetchScreener = async (scrId: string) => {
    try {
      const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=${scrId}&count=${limit}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const quotes = data?.finance?.result?.[0]?.quotes || [];
        for (const q of quotes) {
          if (q.symbol && !q.symbol.includes('.')) {
            if (!nominationMap.has(q.symbol)) nominationMap.set(q.symbol, new Set());
            nominationMap.get(q.symbol)!.add(scrId);
          }
        }
      }
    } catch (err) {
      console.warn(`[UniverseService] Failed to fetch screener "${scrId}":`, err);
    }
  };

  const screenerLists = [
    'day_gainers',
    'day_losers',
    'most_actives',
    'most_shorted_stocks',
    'growth_technology_stocks',
    'undervalued_large_caps',
    'undervalued_growth_stocks',
    'aggressive_small_caps',
    'small_cap_gainers',
    'most_active_penny_stocks',
    'recent_52_week_lows',
    'recent_52_week_highs',
    'morningstar_five_star_stocks',
    'undervalued_wide_moat_stocks',
    'portfolio_anchors',
    'solid_large_growth_funds',
    'solid_midcap_growth_funds'
  ];

  // Fetch all screener lists concurrently
  await Promise.all(screenerLists.map(scr => fetchScreener(scr)));

  // Build the final UniverseCandidate list
  const candidates: UniverseCandidate[] = [];

  // Add dynamically sourced tickers
  for (const [symbol, sources] of nominationMap.entries()) {
    const sourceArr = Array.from(sources);
    candidates.push({
      symbol,
      yahooSources: sourceArr,
      yahooConsensus: computeYahooConsensus(sourceArr.length),
    });
  }

  // Inject essential ETFs (may not appear in screener lists)
  const existing = new Set(candidates.map(c => c.symbol));
  for (const etf of ESSENTIAL_ETFS) {
    if (!existing.has(etf)) {
      candidates.push({ symbol: etf, yahooSources: ['essential_etf'], yahooConsensus: 0 });
    }
  }

  const dynamicCount = nominationMap.size;
  console.log(
    `[UniverseService] Built active universe: ${dynamicCount} dynamic + ${candidates.length - dynamicCount} ETFs = ${candidates.length} total`
  );

  return candidates;
}

/**
 * Identify if a symbol is a broad market ETF.
 */
export function isBroadMarketETF(symbol: string): boolean {
  return ['SPY', 'QQQ', 'IWM', 'DIA'].includes(symbol.toUpperCase());
}

/**
 * Identify if a symbol is a sector ETF.
 */
export function isSectorETF(symbol: string): boolean {
  return ['XLF', 'XLK', 'XLV', 'XLE', 'XLY', 'XLI', 'XLP', 'XLU', 'XLB', 'XLRE'].includes(symbol.toUpperCase());
}
