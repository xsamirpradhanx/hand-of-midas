import type { FactorResult } from './factors/types.js';
import type { OHLCVDataPoint } from '../types.js';
import { calculateIndependentEvidence, type IndependentEvidence } from './quant/independentEvidenceEngine.js';
import { getFactors } from './factors/factorRegistry.js';
import { computeConviction } from './quant/conviction.js';
import type { PolygonNewsArticle } from './polygon.js';
import { generateCommitteeSynthesis } from './aiInsights.js';

// ---------------------------------------------------------------------------
// Regime Detection
// ---------------------------------------------------------------------------

type MarketRegime = 'trending' | 'mean_reverting' | 'high_volatility' | 'neutral';

/**
 * Maximum holding horizon trade plans are built for, in daily bars — 20 ≈ 4 weeks.
 * These are swing/options setups measured in days-to-weeks; intraday plays are the
 * screener's job, not this engine's. Must stay in sync with EVALUATION_HORIZON_BARS
 * in scripts/evaluateQuant.ts, since plans are graded over exactly this window.
 */
const HORIZON_BARS = 20;

/**
 * Detect market regime from factor outputs.
 * Reads numeric values directly from factor names/buckets
 * (replaces the previous fragile regex-on-reasoning-string approach).
 */
function detectRegime(factors: FactorResult[]): MarketRegime {
  // Find POSITIONING/REGIME factors by bucket+group membership (not regex on string)
  const hurstFactor = factors.find(f =>
    f.bucket === 'POSITIONING' && f.correlationGroup === 'REGIME' && f.factorName.includes('Trend Persistence')
  );
  const atrFactor = factors.find(f =>
    f.bucket === 'POSITIONING' && f.correlationGroup === 'REGIME' && f.factorName.includes('ATR')
  );

  // Extract the Efficiency Ratio from the reasoning string — kept as last resort,
  // but bucket/group narrows the search first (avoids false matches).
  //
  // This used to parse a Hurst "H = 0.53" value and treat >0.55 as trending. That
  // branch was unreachable: the R/S estimator scored a relentless uptrend at 0.53 and
  // a pure random walk at 0.58, so 'trending' never fired and its whole multiplier
  // table was dead. See factors/hurstExponent.ts for the measurements.
  let efficiencyRatio: number | null = null;
  if (hurstFactor?.reasoning) {
    const match = hurstFactor.reasoning.match(/Efficiency Ratio\s*=\s*([\d.]+)/);
    if (match) efficiencyRatio = parseFloat(match[1]);
  }

  // Extract ATR% — narrowed to ATR factor in POSITIONING bucket
  let atrPct: number | null = null;
  if (atrFactor?.reasoning) {
    const match = atrFactor.reasoning.match(/(\d+\.?\d*)%\s*of price/);
    if (match) atrPct = parseFloat(match[1]);
  }

  if (atrPct !== null && atrPct > 3.0) return 'high_volatility';
  if (efficiencyRatio !== null && efficiencyRatio > 0.30) return 'trending';
  if (efficiencyRatio !== null && efficiencyRatio < 0.10) return 'mean_reverting';
  return 'neutral';
}

/**
 * Regime-conditional weight multipliers for each factor category.
 * Multiplier > 1 = up-weight this factor in the current regime.
 * Multiplier < 1 = down-weight (less relevant in this regime).
 *
 * Rationale:
 * - Trending: VWAP and CVD are leading signals; GEX/KAMA reversions are noise
 * - Mean-Reverting: GEX flip and KAMA Z-score are the primary edges
 * - High-Volatility: Term Structure and Risk Reversal capture skew panic; HVLR noise
 * - Neutral: all factors equal weight (no adjustment)
 */
const REGIME_MULTIPLIERS: Record<MarketRegime, Record<string, number>> = {
  trending: {
    'Anchored VWAP': 1.5,
    'Session VWAP': 1.5,
    'Cumulative Volume Delta': 1.4,
    'Trend Persistence': 1.3,
    'Volume Profile': 1.2,
    'KAMA': 0.6,
    'Dealer Microstructure': 0.7,
    'Options Squeeze': 0.8,
  },
  mean_reverting: {
    'Dealer Microstructure': 1.5,
    'KAMA': 1.5,
    'Options Squeeze': 1.3,
    'High-Volume Low-Range': 1.2,
    'Anchored VWAP': 0.7,
    'Session VWAP': 0.7,
    'Cumulative Volume Delta': 0.8,
    'Trend Persistence': 0.6,
  },
  high_volatility: {
    'Volatility Term Structure': 1.6,
    'Risk Reversal Skew': 1.5,
    'ATR Dynamic': 1.4,
    'Dealer Microstructure': 1.2,
    'High-Volume Low-Range': 0.5,
    'Catalyst Drift': 0.7,
  },
  neutral: {},
};

/**
 * Apply regime multipliers to a factor's base weight.
 * Matches factor name by substring so partial names work (e.g. "KAMA" matches "KAMA & Z-Score Distance").
 */
function applyRegimeMultiplier(
  factorName: string,
  baseWeight: number,
  regime: MarketRegime,
  factorStats?: Record<string, { wins: number; losses: number; score: number; tries: number; ambiguous?: number }>
): number {
  let multiplier = 1.0;

  const multipliers = REGIME_MULTIPLIERS[regime];
  for (const [key, regMult] of Object.entries(multipliers)) {
    if (factorName.includes(key)) {
      multiplier = regMult;
      break;
    }
  }

  if (factorStats && factorStats[factorName]) {
    const stats = factorStats[factorName];
    // Calibration uses resolved (wins + losses) outcomes only, matching the
    // policy documented on LearningStats/learningEngine.ts: `tries` also counts
    // AMBIGUOUS (same-bar target+stop) grades, which never contribute to
    // `score`, so dividing by `tries` understates accuracy for any factor that
    // frequently resolves ambiguously — penalizing it for a data-resolution
    // limitation rather than for being wrong.
    const resolvedTries = stats.wins + stats.losses;
    if (resolvedTries >= 3) {
      const accuracy = stats.score / resolvedTries;
      const accMult = Math.max(0.2, accuracy / 0.5);
      multiplier *= accMult;
    }
  }

  return baseWeight * multiplier;
}

export interface AISynthesisResult {
  summary: string;
  aiSynthesis?: string;
  bias: 'bullish' | 'bearish' | 'neutral';
  /**
   * @deprecated Use modelConviction instead.
   * Kept for backward compatibility during migration.
   */
  overallConviction: number;
  /**
   * Conviction score 0–1, derived from IndependentEvidence (netBias + agreementLevel penalty).
   * This is NOT a probability. Do not multiply by 100 and call it "win rate".
   */
  modelConviction: number;
  /**
   * Always null until empirical historical outcomes are loaded from SETUP_STATS.
   * Prevents probability = midasScore * 0.75 antipattern.
   */
  historicalWinProbability: null;
  /**
   * Signal agreement level — key for WULF-type analysis.
   * LOW = bull and bear evidence are close, don't over-trust the bias.
   */
  signalAgreement: number;
  agreementLevel: 'HIGH' | 'MODERATE' | 'LOW';
  /**
   * Zone-construction diagnostics. Populated on every call but only consumed by
   * scripts/zoneAudit.ts — how many candidate levels survived the distance filter,
   * how many clusters they formed, and how many of those clusters were credible.
   * Without this the replay cannot tell a bad *pick* from an empty candidate set.
   */
  zoneDebug?: {
    supportLevels: number; resistanceLevels: number;
    supportClusters: number; resistanceClusters: number;
    supportCredible: number; resistanceCredible: number;
    maxZoneDistanceAtr: number; clusterThresholdAtr: number;
  };
  /** Full bucketed evidence breakdown. */
  evidence: IndependentEvidence;
  demandZone: { top: number; bottom: number; confluence: string[] };
  supplyZone: { top: number; bottom: number; confluence: string[] };
  keyFactors: FactorResult[];
  tradePlan?: {
    bias: 'LONG' | 'SHORT' | 'NO TRADE';
    /**
     * Whether the setup can be acted on right now, separate from whether one exists.
     *
     * `bias` alone conflated two very different verdicts, and after the geometry and
     * structure gates landed almost everything collapsed to NO TRADE — including
     * DIS at 5.1R and NBIS at 4.2R, whose only flaw was that price had not yet
     * pulled back to the level. Those are limit orders waiting to fill, not absent
     * setups, and flattening them into the same label made the engine look silent
     * when it was actually finding things.
     *
     * ACTIONABLE — price is at the entry now.
     * WAITING    — sound setup; price has not reached the trigger.
     * NO SETUP   — no valid setup exists (no structure, unusable geometry, R:R < 1).
     */
    readiness: 'ACTIONABLE' | 'WAITING' | 'NO SETUP';
    archetype: string;
    trigger: number;
    entryZone: string;
    chasePrice: number;
    expectedMove: number;
    majorResistance: number;
    stretchTarget: number;
    stop: number;
    /** Actionable reward:risk — forced to 0 on NO TRADE so gating logic can't act on it. */
    rewardRisk: number;
    /**
     * The plan's true geometric reward:risk, always populated even on NO TRADE.
     *
     * `rewardRisk` is deliberately zeroed for NO TRADE so downstream gates
     * (triggerEngine, screener opportunity scoring) can never treat an
     * unactionable plan as tradeable. But most NO TRADE verdicts now mean
     * "sound setup, price just isn't at the level yet" rather than "bad
     * geometry" — and zeroing threw away the one number that distinguishes
     * them, so a 1.5R setup waiting on a pullback rendered identically to a
     * genuinely broken one. This field carries that information for display.
     */
    potentialRewardRisk: number;
    roomToResistance: number;
    roomToSupport: number;
    confirmation: string;
    invalidation: string;
    whyNow: string;
    confidence: number;
  };
}

/**
 * Compute 14-period ATR from OHLCV bars.
 * Returns ATR as a fraction of current price (e.g. 0.03 = 3%).
 */
function computeAtrPercent(bars: OHLCVDataPoint[], currentPrice: number): number {
  if (!bars || bars.length < 2) return 0.015; // fallback 1.5%
  const period = Math.min(14, bars.length - 1);
  const trValues: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    trValues.push(tr);
  }
  // Simple average of last `period` TR values (quick ATR proxy)
  const slice = trValues.slice(-period);
  const atr = slice.reduce((a, b) => a + b, 0) / slice.length;
  return currentPrice > 0 ? atr / currentPrice : 0.015;
}

/**
 * Standard normal CDF (Abramowitz & Stegun 7.1.26 erf approximation, |ε| < 1.5e-7).
 * Local so the engine keeps zero numeric dependencies.
 */
function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

/**
 * Probability that price trades through a level `distAtr` ATR away at least once
 * within `bars` bars, under a driftless random walk (reflection principle):
 *
 *   P(max|W| >= d) = 2 * Phi(-d / (sigma * sqrt(n)))
 *
 * `BAR_SIGMA_PER_ATR` converts ATR into a per-bar sigma. ATR overstates
 * close-to-close sigma because true range includes gaps and intrabar sweep; with
 * sigma = 1 ATR the model predicts a median 20-bar excursion of ~3.6 ATR, whereas
 * a 320-observation point-in-time replay across 40 symbols measured 2.72 ATR to
 * the high and 1.65 ATR to the low. 0.7 reproduces that observed range.
 */
const BAR_SIGMA_PER_ATR = 0.7;
function reachability(distAtr: number, bars: number): number {
  const sigmaN = BAR_SIGMA_PER_ATR * Math.sqrt(bars);
  if (sigmaN <= 0) return 1;
  return 2 * normalCdf(-Math.abs(distAtr) / sigmaN);
}

/**
 * How many factors the registry defines, memoised.
 *
 * Used as the denominator for conviction coverage. Read lazily rather than at
 * module load because aiQuant rewrites factorRegistry.ts and the count should
 * follow the registry rather than a hardcoded constant that silently drifts.
 */
let _factorCount: number | undefined;
function registeredFactorCount(): number {
  if (_factorCount === undefined) _factorCount = getFactors().length;
  return _factorCount;
}

export class CompositeScoreAgent {
  async synthesize(
    symbol: string,
    currentPrice: number,
    factors: FactorResult[],
    bars?: OHLCVDataPoint[],
    factorStats?: Record<string, { wins: number; losses: number; score: number; tries: number }>,
    news?: PolygonNewsArticle[]
  ): Promise<AISynthesisResult> {
    if (!factors || factors.length === 0) {
      return {
        summary: `Insufficient factor inputs to run AI synthesis for ${symbol}.`,
        bias: 'neutral',
        overallConviction: 0.5,
        modelConviction: 0.5,
        historicalWinProbability: null,
        signalAgreement: 0,
        agreementLevel: 'LOW',
        evidence: {
          evidenceByBucket: {}, bullishScore: 0, bearishScore: 0, neutralScore: 0,
          netBias: 0, signalAgreement: 0, agreementLevel: 'LOW', pluralityBias: 'neutral',
        },
        demandZone: { top: Number((currentPrice * 0.99).toFixed(2)), bottom: Number((currentPrice * 0.97).toFixed(2)), confluence: [] },
        supplyZone: { top: Number((currentPrice * 1.03).toFixed(2)), bottom: Number((currentPrice * 1.01).toFixed(2)), confluence: [] },
        keyFactors: [],
      };
    }

    // ── 1. Detect structural market regime ──────────────────────────────────
    const regime = detectRegime(factors);

    // ── 2. Calculate independent (de-duplicated) evidence ───────────────────
    const evidence = calculateIndependentEvidence(factors);

    // ── 3. Derive model conviction from evidence (NOT synthetic probability) ──
    //   Agreement penalty: LOW agreement reduces conviction even if netBias is strong.
    //   This is the WULF fix: mixed signals should yield LOW conviction, not 78%.
    const expected = registeredFactorCount();
    let modelConviction = computeConviction({
      bullishScore: evidence.bullishScore,
      bearishScore: evidence.bearishScore,
      neutralScore: evidence.neutralScore,
      netBias: evidence.netBias,
      agreementLevel: evidence.agreementLevel,
      coverage: expected > 0 ? factors.length / expected : 1,
    });

    // ── 4. Normalize regime-adjusted weights for zone clustering only ──────────
    // (Regime multipliers still applied to zone/target calc, not to conviction)
    const regimeAdjustedWeights = factors.map(f => ({
      factor: f,
      adjustedWeight: applyRegimeMultiplier(f.factorName, f.weight, regime, factorStats),
    }));
    const activeWeightTotal = regimeAdjustedWeights.reduce((sum, { adjustedWeight }) => sum + adjustedWeight, 0);
    const normalizeWeight = (w: number) => (activeWeightTotal > 0 ? w / activeWeightTotal : 1 / factors.length);

    // Bias from evidence plurality (replaces old bullishWeight > bearishWeight)
    const bias = evidence.pluralityBias;

    // Keep overallConviction for backward compat (mirrors modelConviction)
    const overallConviction = modelConviction;

    // ── 5. Market Structure Clustering ──────────────────────────────────────────
    const atrPct = computeAtrPercent(bars ?? [], currentPrice);
    const atrAbs = currentPrice * atrPct;

    // Clamp factor targets to a reachable distance from spot before clustering, so
    // genuinely remote levels (GEX flip at 2× price, max pain 30% away) don't define
    // a "nearby" zone. They still contribute bias/conviction via the evidence engine.
    //
    // Sized to the holding horizon rather than a flat ±2 ATR: sqrt(HORIZON_BARS) is
    // the expected net displacement of a random walk over that window (~4.5 ATR at 20
    // bars), i.e. how far price can plausibly travel before the plan expires. A level
    // beyond that is not reachable within the hold and should not define a zone.
    // The old flat 2 ATR cutoff sat *below* the distance price routinely covers, so on
    // volatile symbols it discarded every real level (value-area edges, VWAP ±2σ) as
    // "too far" and kept only fabricated near-spot offsets — exactly backwards.
    // Observed on WULF (ATR 9.5%): VAL/VAH at 2.2/3.5 ATR both dropped, while a ±2%
    // placeholder at 0.23 ATR survived and set the zone.
    const MAX_ZONE_DISTANCE = Math.sqrt(HORIZON_BARS) * atrAbs;

    const PRICE_LOCATION_FACTOR_NAMES = [
      'VWAP', 
      'Volume Profile', 
      'Dealer Microstructure', 
      'High-Volume Low-Range',
      'Max Pain'
    ];

    // Classify each level as a support or resistance *candidate* up front, by
    // its raw price vs currentPrice — before any clustering happens. A single
    // factor's buyTarget/sellTarget pair (or several factors' pairs) can sit
    // close enough together to merge under clusterThreshold; if support and
    // resistance candidates were pooled into one array and classified only
    // after merging (by the merged cluster's blended center), a close, strong,
    // multi-factor support could get absorbed into a resistance blob and
    // silently disappear — leaving the nearest "support" to be some distant,
    // single-factor level that never should have out-ranked it.
    const supportLevels: { price: number; weight: number; source: string }[] = [];
    const resistanceLevels: { price: number; weight: number; source: string }[] = [];

    for (const { factor: f, adjustedWeight } of regimeAdjustedWeights) {
      const isPriceLocation = f.bucket === 'PRICE_STRUCTURE' || PRICE_LOCATION_FACTOR_NAMES.some(name => f.factorName.includes(name));
      if (!isPriceLocation) continue;
      if (f.buyTarget !== undefined && f.buyTarget > 0 && Math.abs(f.buyTarget - currentPrice) <= MAX_ZONE_DISTANCE) {
        (f.buyTarget < currentPrice ? supportLevels : resistanceLevels).push({ price: f.buyTarget, weight: adjustedWeight, source: f.factorName });
      }
      if (f.sellTarget !== undefined && f.sellTarget > 0 && Math.abs(f.sellTarget - currentPrice) <= MAX_ZONE_DISTANCE) {
        (f.sellTarget < currentPrice ? supportLevels : resistanceLevels).push({ price: f.sellTarget, weight: adjustedWeight, source: f.factorName });
      }
    }

    // How close two independent levels must be to count as the same zone.
    //
    // Was 0.20×ATR, which is a fifth of a single day's range — tighter than
    // independent methods ever agree when estimating the same support. Measured
    // across WULF/NBIS/DIS/AAPL/UWMC, nothing merged in any of the ten zones: the
    // surviving WULF supports sat at $13.58 / $14.03 / $14.73 with gaps of $0.45 and
    // $0.70 against a $0.33 threshold, so each became its own single-factor "cluster"
    // and every zone shipped with a confluence count of exactly 1.
    //
    // Over a HORIZON_BARS hold price crosses 0.6×ATR in a day or two, so levels that
    // close together are the same decision point. This is the width at which
    // confluence can actually form.
    const clusterThreshold = Math.max(currentPrice * 0.0025, atrAbs * 0.6);

    function buildClusters(levels: { price: number; weight: number; source: string }[]) {
      const sorted = [...levels].sort((a, b) => a.price - b.price);
      const built: { center: number; min: number; max: number; weight: number; sources: string[] }[] = [];
      for (const lvl of sorted) {
        const currentCluster = built[built.length - 1];
        if (currentCluster && lvl.price - currentCluster.max <= clusterThreshold) {
          const newWeight = currentCluster.weight + lvl.weight;
          currentCluster.center = (currentCluster.center * currentCluster.weight + lvl.price * lvl.weight) / newWeight;
          currentCluster.weight = newWeight;
          currentCluster.max = lvl.price;
          if (!currentCluster.sources.includes(lvl.source)) currentCluster.sources.push(lvl.source);
        } else {
          built.push({ center: lvl.price, min: lvl.price, max: lvl.price, weight: lvl.weight, sources: [lvl.source] });
        }
      }
      return built;
    }

    // Both arrays stay ordered by proximity to spot (nearest first) — the stretch
    // target below depends on "the next cluster further out".
    const supports = buildClusters(supportLevels).filter(c => c.weight >= 0.1).sort((a, b) => b.center - a.center);
    const resistances = buildClusters(resistanceLevels).filter(c => c.weight >= 0.1).sort((a, b) => a.center - b.center);

    const REACHABLE_ATR = Math.sqrt(HORIZON_BARS);
    const NO_STRUCTURE = 'No structural level identified';

    // Factors that read price behaviour directly — where trade concentrated, where
    // pivots formed, where heavy volume printed in a tight range. Everything else
    // (VWAP bands, a max-pain strike, a gamma flip) is a derived statistic that can
    // land anywhere relative to actual structure.
    const STRUCTURAL_SOURCES = ['Swing Structure', 'Volume Profile', 'High-Volume Low-Range'];

    /**
     * A zone must be anchored in observed price behaviour and be reachable inside the
     * horizon. Distance alone is not enough: UWMC's Session VWAP sat 0.24×ATR from
     * spot — trivially reachable — while the nearest true resistance pivot was 24.5%
     * away, so a "supply zone" was drawn where price had never once turned. Requiring
     * a structural contributor is what separates a level from a coincidence.
     */
    const isCredible = (c?: { center: number; sources: string[] }) => {
      if (!c) return false;
      if (atrAbs > 0 && Math.abs(c.center - currentPrice) / atrAbs > REACHABLE_ATR) return false;
      return c.sources.some(s => STRUCTURAL_SOURCES.some(k => s.includes(k)));
    };

    /**
     * Choose which cluster becomes the zone.
     *
     * Previously this was simply `[0]` — the nearest cluster, however flimsy. That
     * consistently picked whichever single factor happened to land closest to spot
     * over a genuinely corroborated level further out: on UWMC it took Session VWAP
     * sitting 0.02×ATR away instead of a three-factor cluster ~3×ATR below, and the
     * resulting zone missed the nearest real pivot by 6.8%.
     *
     * Scoring by accumulated weight with a distance penalty keeps the choice honest
     * in both directions — a well-corroborated level wins over a lone nearby one, but
     * not from so far away that price cannot reach it inside the horizon.
     */
    function pickPrimary(clusters: { center: number; weight: number; sources: string[] }[]): number {
      if (clusters.length === 0) return -1;
      let bestIdx = -1;
      let bestScore = -Infinity;
      clusters.forEach((c, i) => {
        if (!isCredible(c)) return;
        const distAtr = atrAbs > 0 ? Math.abs(c.center - currentPrice) / atrAbs : 0;
        // Corroboration counts for more than a single factor repeating itself.
        const corroboration = 1 + 0.5 * (c.sources.length - 1);
        // Distance is penalised by the probability price actually REACHES the level
        // inside the horizon — not by an ad-hoc 1/(1+d)^2 curve.
        //
        // The quadratic was fitted to a single WULF anecdote (a remote value-area/VWAP
        // pair beating a level 0.35×ATR out) and over-corrected by roughly 3×. It is
        // already down to 25% of raw score at 1×ATR and 7% at 2.7×ATR, so the picker
        // was structurally pinned to whatever sat nearest spot. A 320-observation
        // point-in-time replay over 40 symbols (scripts/zoneAudit.ts) measured the
        // consequence: supply zones landed a median 0.82×ATR above spot while the
        // realised 20-bar high printed at 2.72×ATR — 3.3× too close, and price
        // exceeded the supply zone in 72% of cases. Demand, which sits further out by
        // construction, was close to calibrated at 1.41 vs 1.65×ATR.
        //
        // reachability() is near-flat inside ~1×ATR and decays smoothly beyond it, so
        // a genuinely corroborated level 2-3×ATR out can win while a level past the
        // horizon still cannot. isCredible()'s hard sqrt(HORIZON_BARS) ceiling is
        // unchanged and still bounds the search.
        const score = c.weight * corroboration * reachability(distAtr, HORIZON_BARS);
        if (score > bestScore) { bestScore = score; bestIdx = i; }
      });
      return bestIdx;
    }

    // NOTE: credibility is applied when picking, not after. Selecting the
    // best-scoring cluster first and then testing it discards the entire side
    // whenever the top scorer happens to lack a structural contributor — even
    // though a credible cluster sits right behind it. That mistake suppressed
    // demand zones on AAPL, TSLA and NVDA, none of which lack structure.
    const supportIdx = pickPrimary(supports);
    const resistanceIdx = pickPrimary(resistances);

    const defaultSpread = currentPrice * Math.max(0.005, Math.min(0.02, atrPct * 0.3));

    // A cluster built from a single factor level has zero width (min === max)
    // — that reads as a razor-precise exact-tick entry, not a defensible
    // multi-day zone. This system's own grading horizon is ~5 trading days
    // (see evaluateQuant.ts), so a zone should represent a real price range
    // sized to that volatility regime, not whatever a single factor's target
    // happened to compute to. Pad any cluster narrower than defaultSpread —
    // the same width already used for the no-confluence fallback below — up
    // to that floor; wider, genuinely multi-factor clusters are left alone.
    function withMinWidth(cluster: { min: number; max: number }): { min: number; max: number } {
      const width = cluster.max - cluster.min;
      if (width >= defaultSpread) return cluster;
      const pad = (defaultSpread - width) / 2;
      return { min: cluster.min - pad, max: cluster.max + pad };
    }

    /**
     * A level is only worth calling a zone if price can plausibly reach it inside the
     * horizon. Beyond sqrt(HORIZON_BARS) × ATR — the expected displacement over the
     * hold — a cluster describes somewhere price is not going, and the honest answer
     * is that this side has no usable structure.
     *
     * The fallback below used to invent `currentPrice ± defaultSpread` and label it
     * "Estimated Support/Resistance", which is a fabricated band dressed as a finding.
     * UWMC is the case that exposed it: the stock has fallen from ~$10 to $1.60 and
     * its nearest resistance pivot is 24.5% above spot, so no supply zone near price
     * exists to be found — but one was drawn anyway.
     */
    // Construct Demand Zone
    let demandZone = {
      top: Number((currentPrice - defaultSpread).toFixed(2)),
      bottom: Number((currentPrice - defaultSpread * 2).toFixed(2)),
      confluence: [NO_STRUCTURE]
    };
    if (supportIdx >= 0 && isCredible(supports[supportIdx])) {
      const s1 = withMinWidth(supports[supportIdx]);
      demandZone = { top: Number(s1.max.toFixed(2)), bottom: Number(s1.min.toFixed(2)), confluence: supports[supportIdx].sources };
    }

    // Construct Supply Zone
    let supplyZone = {
      top: Number((currentPrice + defaultSpread * 2).toFixed(2)),
      bottom: Number((currentPrice + defaultSpread).toFixed(2)),
      confluence: [NO_STRUCTURE]
    };
    if (resistanceIdx >= 0 && isCredible(resistances[resistanceIdx])) {
      const r1 = withMinWidth(resistances[resistanceIdx]);
      supplyZone = { top: Number(r1.max.toFixed(2)), bottom: Number(r1.min.toFixed(2)), confluence: resistances[resistanceIdx].sources };
    }

    let tradeBias: 'LONG' | 'SHORT' | 'NO TRADE' = 'NO TRADE';
    let archetype = regime === 'trending' ? 'Trend Continuation' : regime === 'high_volatility' ? 'Volatility Reversion' : 'Mean Reversion';
    
    // Initialize defaults
    let trigger = currentPrice;
    let entryZoneStr = 'N/A';
    let chasePrice = currentPrice;
    let stop = currentPrice;
    let expectedMove = 0;
    let majorResistance = supplyZone.bottom;
    let stretchTarget = resistances.length > 1 ? resistances[1].min : supplyZone.top * 1.02;
    let roomToResistance = 0;
    let roomToSupport = 0;
    let rr = 0;
    let confirmation = 'N/A';
    let invalidation = 'N/A';
    let whyNow = 'N/A';

    // Check for squeeze risk and options implied move
    const squeezeFactor = factors.find(f => f.factorName.includes('Options Squeeze Score'));
    const isHighSqueezeRisk = squeezeFactor?.reasoning.includes('HIGH GAMMA SQUEEZE RISK');

    // Expected move: Calculate 1-day expected move (approx 0.35x ATR or options straddle)
    const dailyExpectedMove = Number((currentPrice * atrPct * 0.35).toFixed(2));

    // Trade-plan geometry must be sized to the horizon it is graded on.
    // evaluateQuant grades against EVALUATION_HORIZON_BARS = 20 daily bars (~4 weeks),
    // over which price covers several ATR of path. A target closer than
    // MIN_TARGET_ATR — or a stop tighter than MIN_STOP_ATR — sits inside a single
    // session's noise, so it resolves on random intrabar wiggle rather than on the
    // thesis. Those plans also grade AMBIGUOUS (target and stop both hit in the same
    // bar), which gradeOutcome excludes from both wins and losses — meaning they
    // teach the learning engine nothing while still looking like real setups.
    // Observed pre-fix: WULF (ATR 9.5%) emitted T1 at 0.065 ATR and a stop at
    // 0.33 ATR, a distance exceeded intraday on 98% of days.
    const MIN_TARGET_ATR = 1.0;
    const MIN_STOP_ATR = 0.75;
    const minTargetDist = MIN_TARGET_ATR * atrAbs;
    const minStopDist = MIN_STOP_ATR * atrAbs;
    /** Human-readable reason this plan is too tight to grade, or null if viable. */
    // Stop/target distances are rounded to cents before this check, so a value that
    // is mathematically at the threshold can land a fraction below it and produce the
    // self-contradicting "Stop is 0.75×ATR away (< 0.75×ATR minimum)". Compare with a
    // cent of tolerance so a level exactly on the boundary passes.
    const EPS = 0.01;
    const geometryTooTight = (targetDist: number, stopDist: number): string | null => {
      if (targetDist < minTargetDist - EPS) {
        return `Target is ${(targetDist / atrAbs).toFixed(2)}×ATR away (< ${MIN_TARGET_ATR}×ATR minimum) — inside daily noise for a ${HORIZON_BARS}-bar hold.`;
      }
      if (stopDist < minStopDist - EPS) {
        return `Stop is ${(stopDist / atrAbs).toFixed(2)}×ATR away (< ${MIN_STOP_ATR}×ATR minimum) — would be hit by intraday noise.`;
      }
      return null;
    };

    // A plan built on a fabricated zone is not a plan. When either side fell back to
    // the placeholder band, the trigger/stop/target are all derived from a level that
    // was never found in the data, so no trade can be justified from them.
    const fabricatedSide =
      demandZone.confluence[0] === NO_STRUCTURE ? 'demand'
      : supplyZone.confluence[0] === NO_STRUCTURE ? 'supply'
      : null;

    let readiness: 'ACTIONABLE' | 'WAITING' | 'NO SETUP' = 'NO SETUP';
    let qualityFlag = evidence.agreementLevel === 'LOW' ? 'LOW QUALITY' : '';

    if (bias === 'bullish') {
      trigger = Number(demandZone.top.toFixed(2));
      entryZoneStr = `$${Number((demandZone.top * 0.995).toFixed(2))}–$${Number((demandZone.top * 1.005).toFixed(2))}`;
      chasePrice = Number((trigger + currentPrice * atrPct * 0.3).toFixed(2));

      // Stop sits just under the demand zone, but clamped into [1.5×ATR, MIN_STOP_ATR]
      // below the trigger. The far bound stops one wide zone from creating unbounded
      // risk; the near bound exists because a zone can easily be narrower than a single
      // session's range, and a stop inside daily noise gets taken out by random wiggle
      // rather than by the thesis failing. Previously only the far bound was applied, so
      // narrow zones produced stops ~0.3×ATR away — hit intraday on almost every day.
      const rawStopLong = Number((demandZone.bottom - currentPrice * 0.005).toFixed(2));
      const farStopLong = Number((trigger - 1.5 * atrAbs).toFixed(2));
      const nearStopLong = Number((trigger - minStopDist).toFixed(2));
      stop = Math.max(farStopLong, Math.min(rawStopLong, nearStopLong));
      
      majorResistance = Number(supplyZone.bottom.toFixed(2));
      stretchTarget = Number(supplyZone.top.toFixed(2));
      if (resistances.length > resistanceIdx + 1) stretchTarget = Number(resistances[resistanceIdx + 1].min.toFixed(2));
      
      expectedMove = dailyExpectedMove;
      roomToResistance = ((majorResistance - currentPrice) / currentPrice) * 100;
      roomToSupport = ((currentPrice - demandZone.top) / currentPrice) * 100;

      const risk = trigger - stop;
      const reward = majorResistance - trigger;
      rr = risk > 0 ? Number((reward / risk).toFixed(1)) : 0;

      // Invariants check
      if (stop >= trigger || majorResistance <= trigger) rr = 0;

      const tooTightLong = geometryTooTight(majorResistance - trigger, trigger - stop);

      if (fabricatedSide) {
        tradeBias = 'NO TRADE';
        whyNow = `No ${fabricatedSide} structure within ${REACHABLE_ATR.toFixed(1)}×ATR of spot — nothing to anchor an entry or invalidation to.`;
      } else if (currentPrice > chasePrice) {
        // Setup is sound; price simply has not come to it yet.
        tradeBias = 'NO TRADE';
        readiness = rr >= 1.0 ? 'WAITING' : 'NO SETUP';
        whyNow = rr >= 1.0
          ? `Valid LONG setup at $${trigger} ({rr}R), but price is ${Math.abs(roomToSupport).toFixed(1)}% away — wait for the pullback.`.replace('{rr}', String(rr))
          : `Price is overextended (${roomToSupport.toFixed(1)}% above support) and the setup is only ${rr}R.`;
      } else if (tooTightLong) {
        tradeBias = 'NO TRADE';
        whyNow = tooTightLong;
      } else if (rr < 1.0) {
        tradeBias = 'NO TRADE';
        whyNow = `Reward:Risk is ${rr}R (< 1.0R minimum).`;
      } else {
        tradeBias = 'LONG';
        readiness = 'ACTIONABLE';
        whyNow = `${archetype} near Demand Zone (${demandZone.confluence.length} confluences).`;
      }
      
      confirmation = `Hold $${trigger} on pullbacks and show increasing volume into $${majorResistance}.`;
      // TODO(PR2): switch to "15m close" once multi-TF fetch is live. Today the engine only has daily bars.
      invalidation = `Daily close below $${stop} on above-average volume.`;

    } else if (bias === 'bearish') {
      trigger = Number(supplyZone.bottom.toFixed(2));
      entryZoneStr = `$${Number((supplyZone.bottom * 0.995).toFixed(2))}–$${Number((supplyZone.bottom * 1.005).toFixed(2))}`;
      chasePrice = Number((trigger - currentPrice * atrPct * 0.3).toFixed(2)); // P0 FIX: Chase must be below trigger for short

      // Mirror of the long branch: clamped into [MIN_STOP_ATR, 1.5×ATR] above trigger,
      // so a narrow supply zone can't place the stop inside daily noise.
      const rawStopShort = Number((supplyZone.top + currentPrice * 0.005).toFixed(2));
      const farStopShort = Number((trigger + 1.5 * atrAbs).toFixed(2));
      const nearStopShort = Number((trigger + minStopDist).toFixed(2));
      stop = Math.min(farStopShort, Math.max(rawStopShort, nearStopShort));
      
      majorResistance = Number(demandZone.top.toFixed(2)); // T1 Structural Demand
      stretchTarget = Number(demandZone.bottom.toFixed(2)); // T2 Extended Target
      if (supports.length > supportIdx + 1) stretchTarget = Number(supports[supportIdx + 1].max.toFixed(2));
      
      expectedMove = -dailyExpectedMove;
      roomToResistance = ((currentPrice - majorResistance) / currentPrice) * 100; // Downside room
      roomToSupport = ((supplyZone.bottom - currentPrice) / currentPrice) * 100;

      const risk = stop - trigger;
      const reward = trigger - majorResistance;
      rr = risk > 0 ? Number((reward / risk).toFixed(1)) : 0;

      // Invariants check
      if (stop <= trigger || majorResistance >= trigger) rr = 0;

      const tooTightShort = geometryTooTight(trigger - majorResistance, stop - trigger);

      if (fabricatedSide) {
        tradeBias = 'NO TRADE';
        whyNow = `No ${fabricatedSide} structure within ${REACHABLE_ATR.toFixed(1)}×ATR of spot — nothing to anchor an entry or invalidation to.`;
      } else if (currentPrice < chasePrice) {
        // Setup is sound; price simply has not come to it yet.
        tradeBias = 'NO TRADE';
        readiness = rr >= 1.0 ? 'WAITING' : 'NO SETUP';
        whyNow = rr >= 1.0
          ? `Valid SHORT setup at $${trigger} ({rr}R), but price is ${Math.abs(roomToSupport).toFixed(1)}% away — wait for the pullback.`.replace('{rr}', String(rr))
          : `Price is overextended (${roomToSupport.toFixed(1)}% below resistance) and the setup is only ${rr}R.`;
      } else if (tooTightShort) {
        tradeBias = 'NO TRADE';
        whyNow = tooTightShort;
      } else if (rr < 1.0) {
        tradeBias = 'NO TRADE';
        whyNow = `Reward:Risk is ${rr}R (< 1.0R minimum).`;
      } else {
        tradeBias = 'SHORT';
        readiness = 'ACTIONABLE';
        if (isHighSqueezeRisk) {
          archetype = 'Supply Fade / Resistance Rejection';
          whyNow = `Fading supply at $${trigger} amidst heavy Call Open Interest tension. Strictly conditional on rejection.`;
        } else {
          whyNow = `${archetype} near Supply Zone (${supplyZone.confluence.length} confluences).`;
        }
      }

      // P1 FIX: Penalize short conviction if gamma squeeze risk is high
      if (tradeBias === 'SHORT' && isHighSqueezeRisk) {
         modelConviction = Number((modelConviction * 0.5).toFixed(3));
         qualityFlag = qualityFlag ? `${qualityFlag} | HIGH SQUEEZE RISK` : 'HIGH SQUEEZE RISK';
         // TODO(PR2): specify "15m candle rejection" once intraday data is fetched.
         confirmation = `DO NOT SHORT ON TOUCH. Await a rejection candle on the trigger timeframe (currently daily) before entry. A break above $${stop} risks triggering call-gamma squeeze acceleration.`;
      } else {
         confirmation = `Reject $${trigger} on increasing volume.`;
      }

      // TODO(PR2): switch to "15m close" once multi-TF fetch is live.
      invalidation = `Daily close above $${stop} on above-average volume.`;
    }

    // Both branches above write confirmation/invalidation from the zone geometry
    // before the gates decide whether the plan survives. On a rejected plan those
    // sentences quote specific prices to hold and to invalidate on — which reads as
    // an instruction — and when a zone was suppressed for having no structure they
    // quote levels derived from the placeholder band. UWMC printed "Hold $1.58 on
    // pullbacks ... Daily close below $1.43" directly beneath "No demand structure
    // within 4.5×ATR of spot". Say what is missing instead of what to do.
    if (tradeBias === 'NO TRADE') {
      const bothMissing =
        demandZone.confluence[0] === NO_STRUCTURE && supplyZone.confluence[0] === NO_STRUCTURE;
      const structureMissing = fabricatedSide !== null;
      confirmation = structureMissing
        ? `Nothing to confirm — no ${bothMissing ? 'demand or supply' : fabricatedSide} level was found to trade against. Wait for price to build structure.`
        : `Not actionable at $${currentPrice.toFixed(2)}. Revisit if price reaches the ${bias === 'bearish' ? 'supply' : 'demand'} zone.`;
      invalidation = structureMissing
        ? 'N/A — no level to invalidate against.'
        : `Would be $${stop} once triggered, but there is no active position to invalidate.`;
    }

    const tradePlan = {
      bias: tradeBias,
      readiness,
      archetype: qualityFlag ? `${archetype} [${qualityFlag}]` : archetype,
      trigger,
      entryZone: entryZoneStr,
      chasePrice,
      expectedMove: Number(expectedMove.toFixed(2)),
      majorResistance,
      stretchTarget,
      stop,
      // NO TRADE has no valid entry/stop/target (see overextension gate above),
      // so rr — computed from raw structural distances before that gate — must
      // not leak through as a real reward:risk. Downstream scoring in
      // screenerService.ts (tsRR, oppScore) reads this unconditionally.
      rewardRisk: tradeBias === 'NO TRADE' ? 0 : rr,
      potentialRewardRisk: rr,
      roomToResistance: Number(roomToResistance.toFixed(1)),
      roomToSupport: Number(roomToSupport.toFixed(1)),
      confirmation,
      invalidation,
      whyNow,
      confidence: Math.round(modelConviction * 100) // P0 FIX: Unified conviction
    };

    const topFactorDetails = factors
      .map(f => `• [${f.factorName}] (${f.bias.toUpperCase()}): ${f.reasoning}`)
      .join('\n');

    const regimeLabel = regime === 'trending' ? '📈 TRENDING' : regime === 'mean_reverting' ? '↔️ MEAN-REVERTING' : regime === 'high_volatility' ? '⚡ HIGH-VOLATILITY' : '⚖️ NEUTRAL';
    const summary =
      `[AI INVESTMENT COMMITTEE REPORT for ${symbol}]\n` +
      `Regime: ${regimeLabel} | Evidence: ${evidence.pluralityBias.toUpperCase()} (Conviction ${(modelConviction * 100).toFixed(0)}/100, Agreement: ${evidence.agreementLevel}).\n` +
      `Bull Evidence: ${(evidence.bullishScore * 100).toFixed(0)} | Bear Evidence: ${(evidence.bearishScore * 100).toFixed(0)} | Net Bias: ${evidence.netBias > 0 ? '+' : ''}${(evidence.netBias * 100).toFixed(0)}\n` +
      `Active Evidence Buckets: ${Object.values(evidence.evidenceByBucket).filter(b => b.bias !== 'neutral').map(b => b.bucket).join(', ') || 'None'}\n` +
      topFactorDetails;

    // The LLM committee synthesis only adds value when there's an actual setup to
    // comment on — most symbols resolve to NO TRADE (no credible zone, thin R:R,
    // price too far from trigger), and paying for an LLM round trip to narrate
    // "nothing to trade" burns latency and the Gemini free-tier quota (20
    // requests/day) for zero benefit. Mirrors the same gate already used for
    // generateGroundedTradeNarrative below — only ACTIONABLE plans get the
    // qualitative pass; everything else uses the deterministic report as-is.
    const aiSynthesis = tradeBias !== 'NO TRADE'
      ? await generateCommitteeSynthesis(symbol, summary, news)
      : summary;

    const zoneDebug = {
      supportLevels: supportLevels.length,
      resistanceLevels: resistanceLevels.length,
      supportClusters: supports.length,
      resistanceClusters: resistances.length,
      supportCredible: supports.filter(isCredible).length,
      resistanceCredible: resistances.filter(isCredible).length,
      maxZoneDistanceAtr: atrAbs > 0 ? Number((MAX_ZONE_DISTANCE / atrAbs).toFixed(2)) : 0,
      clusterThresholdAtr: atrAbs > 0 ? Number((clusterThreshold / atrAbs).toFixed(2)) : 0,
    };

    return {
      summary,
      aiSynthesis,
      zoneDebug,
      bias,
      overallConviction,
      modelConviction,
      historicalWinProbability: null,
      signalAgreement: evidence.signalAgreement,
      agreementLevel: evidence.agreementLevel,
      evidence,
      demandZone,
      supplyZone,
      keyFactors: factors,
      tradePlan
    };
  }
}
