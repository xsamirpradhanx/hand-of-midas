/**
 * The production engine, as a replayable strategy.
 *
 * This is what makes the harness worth having: it replays `CompositeScoreAgent`
 * itself rather than a reimplementation. A backtest of a parallel model measures
 * a system nobody runs.
 *
 * Look-ahead is prevented structurally upstream — `DecisionContext.bars` is a
 * frozen slice ending at the decision bar, and everything here derives from that
 * slice alone.
 *
 * ONE HONEST LIMITATION: options chains, news and sentiment cannot be
 * reconstructed for a past date, so the OPTIONS and CATALYST factors go silent
 * during replay. Zones are unaffected — only PRICE_STRUCTURE factors feed zone
 * clustering — but conviction is NOT comparable to live, because coverage counts
 * the silent factors as missing. Compare replay against replay, never against
 * live conviction.
 */
import { getFactors } from '../factors/factorRegistry.js';
import { CompositeScoreAgent } from '../compositeScore.js';
import type { FactorInput, FactorResult } from '../factors/types.js';
import type { OHLCVDataPoint } from '../../types.js';
import type { BacktestPlan, BacktestStrategy, DecisionContext } from './types.js';

/** Bars the factor set needs before its first usable read; mirrors production. */
export const COMPOSITE_WARMUP_BARS = 126;

export interface CompositeStrategyOptions {
  /**
   * Emit a plan even when the engine says NO TRADE.
   *
   * Off by default so the replay measures what would actually have been traded.
   * Turn on to score zone placement across every bar, including the ones the
   * engine declined — a much larger sample for geometry work, and useless for
   * expectancy.
   */
  readonly includeNoTrade?: boolean;
}

function toOhlcv(bars: DecisionContext['bars']): OHLCVDataPoint[] {
  return bars.map(b => ({
    datetime: b.datetime,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  })) as OHLCVDataPoint[];
}

/** Wilder-style ATR over the trailing window, from visible bars only. */
function atr(bars: DecisionContext['bars'], period = 14): number {
  const window = bars.slice(-(period + 1));
  if (window.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < window.length; i++) {
    const p = window[i - 1], c = window[i];
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return sum / (window.length - 1);
}

const NO_STRUCTURE = 'No structural level identified';

export class CompositeStrategy implements BacktestStrategy {
  readonly name = 'composite';
  private readonly agent = new CompositeScoreAgent();
  private readonly factors = getFactors();

  constructor(private readonly options: CompositeStrategyOptions = {}) {}

  async plan(ctx: DecisionContext): Promise<BacktestPlan | null> {
    const bars = toOhlcv(ctx.bars);
    if (bars.length < 2) return null;
    const spot = bars[bars.length - 1].close;

    const input: FactorInput = {
      symbol: ctx.symbol,
      currentPrice: spot,
      bars,
      // Deliberately absent — not reconstructible for a historical date.
      intradayBars: undefined,
      optionsChain: undefined,
      activeExpiry: undefined,
      sentiment: undefined,
      news: undefined,
    } as FactorInput;

    const results: FactorResult[] = [];
    for (const f of this.factors) {
      try {
        const r = await f.evaluate(input);
        if (r) results.push(r);
      } catch {
        // A factor that throws on historical data abstains rather than aborting
        // the whole replay.
      }
    }
    if (results.length === 0) return null;

    // Pass learned accuracy through so compositeScore's accuracy multiplier is
    // actually exercised. The replay only supplies outcomes that had resolved by
    // this bar, so this is walk-forward rather than hindsight.
    const synth = await this.agent.synthesize(
      ctx.symbol, spot, results, bars, ctx.factorStats as any,
    );
    const tp: any = synth.tradePlan;
    if (!tp) return null;

    const dz = (synth as any).demandZone;
    const sz = (synth as any).supplyZone;
    const zones = {
      demandZone: dz && { top: dz.top, bottom: dz.bottom, structural: dz.confluence?.[0] !== NO_STRUCTURE },
      supplyZone: sz && { top: sz.top, bottom: sz.bottom, structural: sz.confluence?.[0] !== NO_STRUCTURE },
      atr: atr(ctx.bars),
    };

    const factorVotes = results.map(r => ({ factorName: r.factorName, bias: r.bias }));
    const meta = {
      conviction: synth.modelConviction,
      regime: (tp.archetype as string) ?? undefined,
      coverage: this.factors.length > 0 ? results.length / this.factors.length : undefined,
    };
    const actionable = tp.bias === 'LONG' || tp.bias === 'SHORT';

    if (!actionable) {
      if (!this.options.includeNoTrade) return null;
      // A NO TRADE plan has no defensible entry/stop/target, so it is emitted
      // only to carry zone geometry. Its grade is meaningless and the runner
      // reports expectancy separately from placement for exactly this reason.
      return {
        bias: 'LONG',
        entry: spot,
        stop: tp.stop ?? spot,
        target: tp.majorResistance ?? spot,
        factors: factorVotes,
        setupKey: `NO_TRADE|${tp.archetype ?? 'unknown'}`,
        ...zones, ...meta,
      };
    }

    return {
      bias: tp.bias,
      entry: tp.trigger,
      stop: tp.stop,
      target: tp.majorResistance,
      factors: factorVotes,
      setupKey: `${tp.archetype ?? 'unknown'}|${tp.bias}`,
      ...zones, ...meta,
    };
  }
}
