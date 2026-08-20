/**
 * The symbol universe to keep historical bars for.
 *
 * This is deliberately a curated list rather than the dynamic screener universe
 * from `universeService`. A backtest universe must be *fixed* — if it changes
 * with today's Yahoo screener output, every re-run measures a different
 * population and the results are not comparable across runs.
 *
 * Inception dates in the comments were measured against the live Schwab API on
 * 2026-08-19, not looked up. Schwab returns full listed history in one request.
 *
 * SURVIVORSHIP BIAS: every name here is listed today. Schwab returns zero bars
 * for delisted symbols (verified with FTCH), so a cross-sectional study run over
 * this universe systematically excludes companies that failed. That is fine for
 * per-symbol strategy replay — the intended use — and invalid for "what would a
 * screener have picked in 2007" questions. Say so in any result built on it.
 */

import { scanItems } from '../dynamodb.js';
import type { WatchlistItem } from '../../types.js';

export type UniverseTier = 'benchmark' | 'sector' | 'group' | 'macro' | 'vol' | 'core' | 'watchlist';

export interface UniverseEntry {
  readonly symbol: string;
  readonly tier: UniverseTier;
  /** Why this symbol earns a slot in the store. */
  readonly role: string;
}

/**
 * Broad benchmarks and breadth proxies.
 *
 * Relative strength, regime detection and beta-adjusted sizing all need an
 * index series alongside the name being traded; RSP vs SPY is the cheapest
 * breadth signal available without constituent data.
 */
const BENCHMARKS: readonly UniverseEntry[] = [
  { symbol: 'SPY', tier: 'benchmark', role: 'primary benchmark, regime anchor (1993)' },
  { symbol: 'QQQ', tier: 'benchmark', role: 'large-cap growth benchmark (1999)' },
  { symbol: 'IWM', tier: 'benchmark', role: 'small-cap benchmark, risk appetite (2000)' },
  { symbol: 'DIA', tier: 'benchmark', role: 'mega-cap value benchmark (1998)' },
  { symbol: 'MDY', tier: 'benchmark', role: 'mid-cap, deepest non-SPY history (1995)' },
  { symbol: 'RSP', tier: 'benchmark', role: 'equal-weight S&P — breadth proxy vs SPY (2003)' },
  { symbol: 'VTI', tier: 'benchmark', role: 'total market (2001)' },
];

/** The nine original SPDR sectors run to 1998; XLRE and XLC are later spin-offs. */
const SECTORS: readonly UniverseEntry[] = [
  { symbol: 'XLK', tier: 'sector', role: 'technology (1998)' },
  { symbol: 'XLF', tier: 'sector', role: 'financials (1998)' },
  { symbol: 'XLV', tier: 'sector', role: 'health care (1998)' },
  { symbol: 'XLE', tier: 'sector', role: 'energy (1998)' },
  { symbol: 'XLY', tier: 'sector', role: 'consumer discretionary (1998)' },
  { symbol: 'XLP', tier: 'sector', role: 'consumer staples (1998)' },
  { symbol: 'XLI', tier: 'sector', role: 'industrials (1998)' },
  { symbol: 'XLU', tier: 'sector', role: 'utilities (1998)' },
  { symbol: 'XLB', tier: 'sector', role: 'materials (1998)' },
  { symbol: 'XLRE', tier: 'sector', role: 'real estate — 2015 spin-off, no pre-GFC history' },
  { symbol: 'XLC', tier: 'sector', role: 'communication services — 2018 spin-off' },
];

/** Sub-industry groups whose dispersion the broad sectors hide. */
const GROUPS: readonly UniverseEntry[] = [
  { symbol: 'SMH', tier: 'group', role: 'semis — highest-beta group, spans 2000 bust (2000)' },
  { symbol: 'XBI', tier: 'group', role: 'biotech — equal-weight, rate-sensitive (2006)' },
  { symbol: 'KRE', tier: 'group', role: 'regional banks — 2023 stress regime (2006)' },
  { symbol: 'ARKK', tier: 'group', role: 'long-duration growth proxy (2014)' },
  { symbol: 'IBIT', tier: 'group', role: 'spot BTC — crypto beta for the miner names (2024)' },
];

/** Rates, credit, dollar and commodities: the macro backdrop factors read from. */
const MACRO: readonly UniverseEntry[] = [
  { symbol: 'TLT', tier: 'macro', role: 'long duration (2002)' },
  { symbol: 'IEF', tier: 'macro', role: 'intermediate duration (2002)' },
  { symbol: 'SHY', tier: 'macro', role: 'front end — TLT/SHY is a curve proxy (2002)' },
  { symbol: 'HYG', tier: 'macro', role: 'high yield — credit stress (2007)' },
  { symbol: 'LQD', tier: 'macro', role: 'investment grade — HYG/LQD spread proxy (2002)' },
  { symbol: 'UUP', tier: 'macro', role: 'dollar index (2007)' },
  { symbol: 'GLD', tier: 'macro', role: 'gold (2004)' },
  { symbol: 'SLV', tier: 'macro', role: 'silver — higher-beta gold (2006)' },
  { symbol: 'USO', tier: 'macro', role: 'crude (2006)' },
  { symbol: 'DBC', tier: 'macro', role: 'broad commodities (2006)' },
  { symbol: 'GDX', tier: 'macro', role: 'gold miners — levered gold (2006)' },
];

/**
 * Volatility.
 *
 * ^VIX comes from Yahoo: Schwab's pricehistory endpoint returns empty for every
 * index symbol tried ($VIX.X, $VIX3M.X, $VXN.X, $TNX.X). The VIX ETPs only
 * start in 2011 and decay, so they measure a different thing than the index —
 * keep both and never substitute one for the other.
 */
const VOL: readonly UniverseEntry[] = [
  { symbol: '^VIX', tier: 'vol', role: 'VIX index via Yahoo — 1990, covers every crisis' },
  { symbol: 'VIXY', tier: 'vol', role: 'tradeable short-term VIX futures (2011)' },
  { symbol: 'VXX', tier: 'vol', role: 'the liquid VIX ETN (2018 in current form)' },
  { symbol: 'UVXY', tier: 'vol', role: 'levered vol — tail-hedge behaviour (2011)' },
];

/**
 * Long-history liquid single names.
 *
 * These matter more than anything else in the file: they are the only symbols
 * that span 1987, 2000, 2008, 2020 and 2022. A factor validated only on names
 * listed after 2020 has been validated on one bull market and one drawdown.
 * Chosen for continuous liquidity and sector spread, not for being interesting.
 */
const CORE: readonly UniverseEntry[] = [
  { symbol: 'AAPL', tier: 'core', role: 'mega-cap tech (1985)' },
  { symbol: 'MSFT', tier: 'core', role: 'mega-cap tech (1986)' },
  { symbol: 'NVDA', tier: 'core', role: 'semis, extreme trend regime (1999)' },
  { symbol: 'AMD', tier: 'core', role: 'high-beta semis, multiple full cycles (1985)' },
  { symbol: 'INTC', tier: 'core', role: 'semis in secular decline — the other tail (1986)' },
  { symbol: 'MU', tier: 'core', role: 'memory cycle, textbook mean reversion (1989)' },
  { symbol: 'AMZN', tier: 'core', role: 'survived a 94% drawdown (1997)' },
  { symbol: 'GOOGL', tier: 'core', role: 'mega-cap (2004)' },
  { symbol: 'META', tier: 'core', role: 'gap-risk on earnings (2012)' },
  { symbol: 'NFLX', tier: 'core', role: 'largest single-day earnings gaps in the set (2002)' },
  { symbol: 'ORCL', tier: 'core', role: 'enterprise software (1988)' },
  { symbol: 'CSCO', tier: 'core', role: 'the 2000 bubble control case (1990)' },
  { symbol: 'JPM', tier: 'core', role: 'money-center bank (1985)' },
  { symbol: 'BAC', tier: 'core', role: 'GFC epicentre (1986)' },
  { symbol: 'C', tier: 'core', role: 'GFC survivor with a reverse split (1984)' },
  { symbol: 'GS', tier: 'core', role: 'investment bank (1999)' },
  { symbol: 'XOM', tier: 'core', role: 'energy major (1985)' },
  { symbol: 'CVX', tier: 'core', role: 'energy major (1985)' },
  { symbol: 'CAT', tier: 'core', role: 'global industrial cycle (1985)' },
  { symbol: 'DE', tier: 'core', role: 'ag/industrial cycle (1985)' },
  { symbol: 'GE', tier: 'core', role: 'multi-decade decline and breakup (1985)' },
  { symbol: 'BA', tier: 'core', role: 'idiosyncratic event risk (1984)' },
  { symbol: 'LMT', tier: 'core', role: 'defense, low-beta (1985)' },
  { symbol: 'F', tier: 'core', role: 'low-priced cyclical (1984)' },
  { symbol: 'JNJ', tier: 'core', role: 'defensive health care (1985)' },
  { symbol: 'PFE', tier: 'core', role: 'pharma (1985)' },
  { symbol: 'UNH', tier: 'core', role: 'managed care (1990)' },
  { symbol: 'KO', tier: 'core', role: 'low-vol staple (1985)' },
  { symbol: 'PG', tier: 'core', role: 'low-vol staple (1985)' },
  { symbol: 'WMT', tier: 'core', role: 'retail (1985)' },
  { symbol: 'HD', tier: 'core', role: 'housing-linked retail (1985)' },
  { symbol: 'DIS', tier: 'core', role: 'consumer media (1985)' },
  { symbol: 'T', tier: 'core', role: 'telecom, dividend-heavy (1985)' },
  { symbol: 'TSLA', tier: 'core', role: 'highest realized vol in the mega-caps (2010)' },
];

export const CURATED_UNIVERSE: readonly UniverseEntry[] = [
  ...BENCHMARKS,
  ...SECTORS,
  ...GROUPS,
  ...MACRO,
  ...VOL,
  ...CORE,
];

/**
 * Symbols the user actually follows, read from the watchlist partitions.
 *
 * Read live rather than hardcoded so the store tracks the watchlist as it
 * changes. Note that most watchlist names are young — of the 22 present on
 * 2026-08-19, 14 first traded in 2020 or later and several have under 70 bars
 * — so they can be replayed but cannot be used to validate a factor across
 * regimes. That is what the `core` tier is for.
 */
export async function getWatchlistSymbols(): Promise<string[]> {
  const items = await scanItems<WatchlistItem>({
    FilterExpression: 'begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':prefix': 'WATCHLIST#' },
  });
  const symbols = new Set<string>();
  for (const item of items) {
    const symbol = item.symbol ?? item.sk.replace('WATCHLIST#', '');
    if (symbol) symbols.add(symbol.toUpperCase());
  }
  return Array.from(symbols).sort();
}

/**
 * The full backfill universe: curated tiers plus the live watchlist, deduped.
 * Curated entries win on collision so their `role` annotation survives.
 */
export async function resolveUniverse(options: { tiers?: UniverseTier[] } = {}): Promise<UniverseEntry[]> {
  const tiers = options.tiers;
  const wanted = tiers ? new Set(tiers) : null;

  const entries = new Map<string, UniverseEntry>();

  for (const entry of CURATED_UNIVERSE) {
    if (wanted && !wanted.has(entry.tier)) continue;
    entries.set(entry.symbol, entry);
  }

  if (!wanted || wanted.has('watchlist')) {
    for (const symbol of await getWatchlistSymbols()) {
      if (entries.has(symbol)) continue;
      entries.set(symbol, { symbol, tier: 'watchlist', role: 'user watchlist' });
    }
  }

  return Array.from(entries.values());
}
