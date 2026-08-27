import type { OHLCVDataPoint } from '../../types.js';
import type { PolygonNewsArticle } from '../polygon.js';
import { getTimeSeriesYahoo } from '../yahoo.js';
import type { FactorResult } from '../factors/types.js';
import { AI_AVAILABLE, generateText } from '../aiProvider.js';
import { aiCacheKey, withAiCache } from '../aiCache.js';

export type BusinessArchetype = 'AI_INFRASTRUCTURE' | 'DIGITAL_ASSET_MINER' | 'HYBRID_TRANSITION' | 'GENERAL';
export type MarketDriver = 'AI_INFRASTRUCTURE' | 'DIGITAL_ASSET_MINER' | 'MIXED' | 'INDETERMINATE';

export interface SymbolProfile {
  businessArchetype: BusinessArchetype;
  marketDriver: MarketDriver;
  aiInfrastructureCorrelation: number | null;
  minerCorrelation: number | null;
  prioritySignals: string[];
  deprioritizedSignals: string[];
  rationale: string;
  source: 'LLM_AND_MARKET_DATA' | 'MARKET_DATA' | 'DEFAULT';
}

const AI_INFRA_TICKERS = ['NBIS', 'VRT', 'ETN', 'GEV', 'DLR', 'EQIX'];
const MINER_TICKERS = ['MARA', 'RIOT', 'CLSK', 'IREN'];
const KNOWN_HYBRIDS = new Set(['WULF']);

/**
 * One hour. Shared across processes via aiCache rather than held in an
 * in-process Map: the API Lambda and ScreenerRefreshFunction profile the same
 * symbols, and each cold start used to re-pay the LLM classification plus ten
 * Yahoo peer fetches for a classification that changes on a scale of weeks.
 */
const PROFILE_TTL_SECONDS = 60 * 60;

function returns(bars: OHLCVDataPoint[]): number[] {
  return bars.slice(-40).map((bar, index, source) => {
    if (index === 0 || source[index - 1]!.close <= 0) return 0;
    return (bar.close - source[index - 1]!.close) / source[index - 1]!.close;
  }).slice(1);
}

export function correlation(a: number[], b: number[]): number | null {
  const length = Math.min(a.length, b.length);
  if (length < 10) return null;
  const x = a.slice(-length);
  const y = b.slice(-length);
  const xMean = x.reduce((sum, value) => sum + value, 0) / length;
  const yMean = y.reduce((sum, value) => sum + value, 0) / length;
  let numerator = 0, xVariance = 0, yVariance = 0;
  for (let i = 0; i < length; i++) {
    const xDiff = x[i]! - xMean;
    const yDiff = y[i]! - yMean;
    numerator += xDiff * yDiff;
    xVariance += xDiff * xDiff;
    yVariance += yDiff * yDiff;
  }
  if (xVariance === 0 || yVariance === 0) return null;
  return Number((numerator / Math.sqrt(xVariance * yVariance)).toFixed(3));
}

function average(values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value !== null);
  return valid.length ? Number((valid.reduce((sum, value) => sum + value, 0) / valid.length).toFixed(3)) : null;
}

function defaultArchetype(symbol: string, news: PolygonNewsArticle[] | undefined): BusinessArchetype {
  const headlines = (news ?? []).map(article => `${article.title ?? ''} ${article.description ?? ''}`).join(' ').toLowerCase();
  if (KNOWN_HYBRIDS.has(symbol) || (/(data cent(er|re)|hyperscal|ai infrastructure|high.performance comput)/.test(headlines) && /(bitcoin|miner|mining|hash)/.test(headlines))) return 'HYBRID_TRANSITION';
  if (/(data cent(er|re)|hyperscal|ai infrastructure|gpu cloud|high.performance comput)/.test(headlines)) return 'AI_INFRASTRUCTURE';
  if (/(bitcoin|miner|mining|hash rate|hashrate)/.test(headlines)) return 'DIGITAL_ASSET_MINER';
  return 'GENERAL';
}

async function classifyNarrative(symbol: string, news: PolygonNewsArticle[] | undefined, fallback: BusinessArchetype): Promise<{ archetype: BusinessArchetype; rationale: string; usedLlm: boolean }> {
  if (!AI_AVAILABLE || !news?.length || fallback === 'GENERAL') return { archetype: fallback, rationale: 'Classified from vetted ticker and headline keywords.', usedLlm: false };
  const headlines = news.slice(0, 10).map(article => article.title).filter(Boolean);
  try {
    const text = await generateText(
      `Classify ${symbol}'s current business narrative from these headlines only. Return strict JSON with archetype (one of AI_INFRASTRUCTURE, DIGITAL_ASSET_MINER, HYBRID_TRANSITION, GENERAL) and rationale (max 25 words). Do not assess price, recommend a trade, or infer facts not in the headlines. Headlines: ${JSON.stringify(headlines)}`,
      { json: true },
    );
    const parsed = JSON.parse(text ?? '{}') as { archetype?: BusinessArchetype; rationale?: string };
    const allowed: BusinessArchetype[] = ['AI_INFRASTRUCTURE', 'DIGITAL_ASSET_MINER', 'HYBRID_TRANSITION', 'GENERAL'];
    if (parsed.archetype && allowed.includes(parsed.archetype)) {
      return { archetype: parsed.archetype, rationale: parsed.rationale || 'LLM classified supplied headlines.', usedLlm: true };
    }
  } catch (error) {
    console.warn(`[SymbolProfile] Narrative classifier unavailable for ${symbol}:`, error);
  }
  return { archetype: fallback, rationale: 'Classified from vetted ticker and headline keywords.', usedLlm: false };
}

export async function buildSymbolProfile(symbol: string, bars: OHLCVDataPoint[], news?: PolygonNewsArticle[], options?: { skipLlm?: boolean }): Promise<SymbolProfile> {
  // Keyed on the symbol and the archetype the headlines imply, not on the
  // headlines themselves — a new article every few minutes would otherwise miss
  // the cache constantly while never changing the answer.
  const key = aiCacheKey('symbol-profile', { symbol, seed: defaultArchetype(symbol, news) });
  const profile = await withAiCache<SymbolProfile>(key, PROFILE_TTL_SECONDS, () =>
    computeSymbolProfile(symbol, bars, news, options),
  );
  // withAiCache only returns null when `compute` does, which this never does.
  return profile ?? { businessArchetype: 'GENERAL', marketDriver: 'INDETERMINATE', aiInfrastructureCorrelation: null, minerCorrelation: null, prioritySignals: ['price structure', 'liquidity', 'market regime'], deprioritizedSignals: [], rationale: 'Profile unavailable.', source: 'DEFAULT' };
}

async function computeSymbolProfile(symbol: string, bars: OHLCVDataPoint[], news?: PolygonNewsArticle[], options?: { skipLlm?: boolean }): Promise<SymbolProfile> {
  const fallback = defaultArchetype(symbol, news);
  // The LLM only refines the archetype the ticker/headline keywords already
  // produced, and it is bypassed entirely for GENERAL symbols (the common case)
  // — so skipping it costs at most a coarser archetype, never a missing one.
  const narrative = options?.skipLlm
    ? { archetype: fallback, rationale: 'Classified from vetted ticker and headline keywords.', usedLlm: false }
    : await classifyNarrative(symbol, news, fallback);
  const needsComparisons = narrative.archetype !== 'GENERAL';
  if (!needsComparisons) {
    return { businessArchetype: narrative.archetype, marketDriver: 'INDETERMINATE', aiInfrastructureCorrelation: null, minerCorrelation: null, prioritySignals: ['price structure', 'liquidity', 'market regime'], deprioritizedSignals: [], rationale: narrative.rationale, source: narrative.usedLlm ? 'LLM_AND_MARKET_DATA' : 'DEFAULT' };
  }

  const symbolReturns = returns(bars);
  const peers = [...AI_INFRA_TICKERS, ...MINER_TICKERS].filter(ticker => ticker !== symbol);
  const peerBars = await Promise.all(peers.map(async ticker => ({ ticker, bars: await getTimeSeriesYahoo(ticker, '1d', 45).catch(() => []) })));
  const correlations = new Map(peerBars.map(({ ticker, bars: peer }) => [ticker, correlation(symbolReturns, returns(peer))]));
  const aiCorrelation = average(AI_INFRA_TICKERS.map(ticker => correlations.get(ticker) ?? null));
  const minerCorrelation = average(MINER_TICKERS.map(ticker => correlations.get(ticker) ?? null));
  const edge = (aiCorrelation ?? 0) - (minerCorrelation ?? 0);
  const marketDriver: MarketDriver = aiCorrelation === null && minerCorrelation === null ? 'INDETERMINATE'
    : Math.abs(edge) < 0.12 ? 'MIXED'
    : edge > 0 ? 'AI_INFRASTRUCTURE' : 'DIGITAL_ASSET_MINER';
  const prioritySignals = marketDriver === 'AI_INFRASTRUCTURE'
    ? ['AI-infrastructure peer relative strength', 'data-center/power catalysts', 'intraday VWAP and time-adjusted RVOL', 'capex and financing risk']
    : marketDriver === 'DIGITAL_ASSET_MINER'
      ? ['miner peer relative strength', 'BTC lead/lag', 'intraday VWAP and time-adjusted RVOL', 'hash-price and energy catalysts']
      : ['AI-infrastructure and miner peer relative strength', 'intraday VWAP and time-adjusted RVOL', 'catalyst and financing risk'];
  const driverLabel = marketDriver === 'INDETERMINATE' ? 'not yet measurable' : marketDriver.toLowerCase().replace('_', ' ');
  return {
    businessArchetype: narrative.archetype, marketDriver, aiInfrastructureCorrelation: aiCorrelation, minerCorrelation,
    prioritySignals, deprioritizedSignals: ['unsupported distant options levels', 'generic narrative without price confirmation'],
    rationale: `${narrative.rationale} Rolling return correlation indicates ${driverLabel} is the stronger current driver (AI infra: ${aiCorrelation ?? 'n/a'}, miners: ${minerCorrelation ?? 'n/a'}).`,
    source: narrative.usedLlm ? 'LLM_AND_MARKET_DATA' : 'MARKET_DATA',
  };
}

export function applySymbolProfile(factors: FactorResult[], profile: SymbolProfile): FactorResult[] {
  const multiplier = (factor: FactorResult): number => {
    if (factor.bucket === 'PRICE_STRUCTURE' || factor.bucket === 'ORDER_FLOW') return 1.2;
    if (factor.bucket === 'CATALYST') return profile.marketDriver === 'INDETERMINATE' ? 1 : 1.25;
    if (factor.bucket === 'OPTIONS' && profile.marketDriver === 'MIXED') return 0.9;
    return 1;
  };
  return factors.map(factor => ({ ...factor, weight: Number(Math.min(1, factor.weight * multiplier(factor)).toFixed(3)) }));
}
