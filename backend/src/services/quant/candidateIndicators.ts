/**
 * The candidate pool the lab searches over.
 *
 * Two rules constrain what can appear here, and both come from how the result
 * has to be used rather than from statistics:
 *
 * 1. **Computable from one symbol's own bars.** A cross-sectional construct
 *    ("rank this name against its peers today") measures well but cannot be
 *    implemented as a `PredictiveFactor`, which is handed a single symbol. Every
 *    candidate is therefore self-normalising — a z-score or ratio against the
 *    symbol's own trailing distribution — so it is comparable across symbols
 *    without ever seeing them. The benchmark series is the one exception, and
 *    is available to the live engine as an ordinary SPY fetch.
 *
 * 2. **Signed toward the forecast**, positive meaning bullish over the next 20
 *    bars. Several of these families are documented as NEGATIVE predictors
 *    (lottery-like max return, idiosyncratic volatility, short-horizon
 *    reversal); they carry their negation here so the pool never contains the
 *    same idea in two orientations. Searching both orientations doubles the
 *    multiple-testing burden for no information.
 *
 * The pool deliberately mixes families with a documented prior (52-week-high
 * proximity, MAX, low-volatility, illiquidity, reversal, residual momentum)
 * against structural ones with no prior. The documented ones are the control:
 * if a search cannot recover effects that are known to exist in equity panels,
 * the measurement is broken and nothing it likes should be trusted either.
 */

import type { BarPanel } from '../backtest/barCache.js';
import type { IndicatorCandidate, MarketContext } from './indicatorLab.js';
import {
  atrSeries, logReturns, rollMax, rollMean, rollMin, rollStd, rollSum, rollRegression, zScore,
} from './indicatorPrimitives.js';

const NA = (n: number) => new Float64Array(n).fill(NaN);

/** Benchmark log returns aligned onto this symbol's bar index. */
function alignedBenchReturns(panel: BarPanel, market: MarketContext): Float64Array {
  const out = new Float64Array(panel.n).fill(NaN);
  for (let i = 0; i < panel.n; i++) {
    const d = market.dateIndexOf[i];
    if (d >= 0) out[i] = market.benchRet[d];
  }
  return out;
}

// ── families ───────────────────────────────────────────────────────────────

/**
 * Momentum with a skip.
 *
 * `skip` omits the most recent bars from the lookback. The classic 12-1
 * construction exists because the two horizons carry opposite signs — the last
 * month reverses while the year before it continues — so a lookback that
 * includes both is the sum of a positive and a negative effect and measures
 * weaker than either.
 */
function momentum(lookback: number, skip: number): IndicatorCandidate {
  return {
    name: `mom_${lookback}_${skip}`,
    family: 'momentum',
    warmup: lookback + skip + 1,
    compute(panel) {
      const out = NA(panel.n);
      for (let i = lookback + skip; i < panel.n; i++) {
        const a = panel.c[i - lookback - skip], b = panel.c[i - skip];
        if (a > 0 && b > 0) out[i] = Math.log(b / a);
      }
      return out;
    },
  };
}

/** Momentum divided by the volatility it was earned through. */
function riskAdjustedMomentum(lookback: number, skip: number): IndicatorCandidate {
  return {
    name: `rmom_${lookback}_${skip}`,
    family: 'risk-adjusted momentum',
    warmup: lookback + skip + 1,
    compute(panel) {
      const r = logReturns(panel.c);
      const sd = rollStd(r, lookback);
      const out = NA(panel.n);
      for (let i = lookback + skip; i < panel.n; i++) {
        const a = panel.c[i - lookback - skip], b = panel.c[i - skip];
        const s = sd[i - skip];
        if (a > 0 && b > 0 && s > 0) out[i] = Math.log(b / a) / (s * Math.sqrt(lookback));
      }
      return out;
    },
  };
}

/** Short-horizon reversal: recent losers outperform. Negated to stay bullish-positive. */
function reversal(lookback: number): IndicatorCandidate {
  return {
    name: `rev_${lookback}`,
    family: 'reversal',
    warmup: lookback + 21,
    compute(panel) {
      const r = logReturns(panel.c);
      const sd = rollStd(r, 60);
      const out = NA(panel.n);
      for (let i = lookback; i < panel.n; i++) {
        const a = panel.c[i - lookback], b = panel.c[i];
        if (a > 0 && b > 0 && sd[i] > 0) out[i] = -Math.log(b / a) / (sd[i] * Math.sqrt(lookback));
      }
      return out;
    },
  };
}

/**
 * Proximity to the trailing high (George & Hwang).
 *
 * Ratio rather than a z-score: it is already unit-free and bounded, and a
 * z-score of a bounded series mostly measures how long it has been pinned.
 */
function highProximity(lookback: number): IndicatorCandidate {
  return {
    name: `nearhigh_${lookback}`,
    family: '52w-high proximity',
    warmup: lookback + 1,
    compute(panel) {
      const hi = rollMax(panel.h, lookback);
      const out = NA(panel.n);
      for (let i = lookback; i < panel.n; i++) if (hi[i] > 0) out[i] = panel.c[i] / hi[i] - 1;
      return out;
    },
  };
}

/** Position inside the trailing range, centred: +0.5 at the high, -0.5 at the low. */
function donchianPosition(lookback: number): IndicatorCandidate {
  return {
    name: `donch_${lookback}`,
    family: 'range position',
    warmup: lookback + 1,
    compute(panel) {
      const hi = rollMax(panel.h, lookback), lo = rollMin(panel.l, lookback);
      const out = NA(panel.n);
      for (let i = lookback; i < panel.n; i++) {
        const span = hi[i] - lo[i];
        if (span > 0) out[i] = (panel.c[i] - lo[i]) / span - 0.5;
      }
      return out;
    },
  };
}

/** Largest single-bar return in the window (lottery demand). Negated. */
function maxEffect(lookback: number): IndicatorCandidate {
  return {
    name: `maxret_${lookback}`,
    family: 'lottery (MAX)',
    warmup: lookback + 1,
    compute(panel) {
      const r = logReturns(panel.c);
      const mx = rollMax(r, lookback);
      const sd = rollStd(r, lookback);
      const out = NA(panel.n);
      for (let i = lookback; i < panel.n; i++) if (sd[i] > 0) out[i] = -mx[i] / sd[i];
      return out;
    },
  };
}

/** Idiosyncratic volatility against the benchmark. Negated (low-vol premium). */
function idiosyncraticVol(lookback: number): IndicatorCandidate {
  return {
    name: `ivol_${lookback}`,
    family: 'idiosyncratic vol',
    warmup: lookback + 2,
    compute(panel, market) {
      const r = logReturns(panel.c);
      const br = alignedBenchReturns(panel, market);
      const { beta, alpha } = rollRegression(r, br, lookback);
      const resid = new Float64Array(panel.n).fill(NaN);
      for (let i = 0; i < panel.n; i++) {
        if (Number.isFinite(beta[i]) && Number.isFinite(r[i]) && Number.isFinite(br[i])) {
          resid[i] = r[i] - alpha[i] - beta[i] * br[i];
        }
      }
      const sd = rollStd(resid, lookback);
      const out = NA(panel.n);
      // Scaled by total volatility so this measures the IDIOSYNCRATIC SHARE
      // rather than volatility itself, which `vol_*` already covers.
      const tot = rollStd(r, lookback);
      for (let i = 0; i < panel.n; i++) if (sd[i] > 0 && tot[i] > 0) out[i] = -sd[i] / tot[i];
      return out;
    },
  };
}

/** Total realised volatility, negated: the low-volatility anomaly. */
function lowVolatility(lookback: number): IndicatorCandidate {
  return {
    name: `lowvol_${lookback}`,
    family: 'low volatility',
    warmup: lookback + 2,
    compute(panel) {
      const r = logReturns(panel.c);
      const sd = rollStd(r, lookback);
      const long = rollStd(r, Math.max(lookback * 4, 252));
      const out = NA(panel.n);
      // Relative to the symbol's own long-run volatility, so this ranks a name
      // against its own history rather than against sector volatility levels.
      for (let i = 0; i < panel.n; i++) if (sd[i] > 0 && long[i] > 0) out[i] = -Math.log(sd[i] / long[i]);
      return out;
    },
  };
}

/** Amihud illiquidity: |return| per dollar traded. Positive predictor. */
function illiquidity(lookback: number): IndicatorCandidate {
  return {
    name: `illiq_${lookback}`,
    family: 'illiquidity',
    warmup: lookback + 2,
    compute(panel) {
      const r = logReturns(panel.c);
      const raw = new Float64Array(panel.n).fill(NaN);
      for (let i = 1; i < panel.n; i++) {
        const dollar = panel.c[i] * panel.v[i];
        if (dollar > 0 && Number.isFinite(r[i])) raw[i] = Math.abs(r[i]) / dollar;
      }
      const m = rollMean(raw, lookback);
      const out = NA(panel.n);
      // Log then z-scored: illiquidity is heavy-tailed by orders of magnitude,
      // and a raw mean would be a readout of a handful of thin days.
      const lg = new Float64Array(panel.n).fill(NaN);
      for (let i = 0; i < panel.n; i++) if (m[i] > 0) lg[i] = Math.log(m[i]);
      const z = zScore(lg, Math.max(lookback * 4, 252));
      for (let i = 0; i < panel.n; i++) out[i] = z[i];
      return out;
    },
  };
}

/** Kaufman efficiency ratio, signed by the direction of the move. */
function efficiencyRatio(lookback: number): IndicatorCandidate {
  return {
    name: `effratio_${lookback}`,
    family: 'trend efficiency',
    warmup: lookback + 2,
    compute(panel) {
      const absMove = new Float64Array(panel.n).fill(NaN);
      for (let i = 1; i < panel.n; i++) absMove[i] = Math.abs(panel.c[i] - panel.c[i - 1]);
      const path = rollSum(absMove, lookback);
      const out = NA(panel.n);
      for (let i = lookback; i < panel.n; i++) {
        const net = panel.c[i] - panel.c[i - lookback];
        if (path[i] > 0) out[i] = net / path[i];
      }
      return out;
    },
  };
}

/** Overnight return share — the close-to-open component, accumulated. */
function overnightDrift(lookback: number): IndicatorCandidate {
  return {
    name: `overnight_${lookback}`,
    family: 'overnight/intraday split',
    warmup: lookback + 2,
    compute(panel) {
      const on = new Float64Array(panel.n).fill(NaN);
      for (let i = 1; i < panel.n; i++) {
        const prev = panel.c[i - 1];
        if (prev > 0 && panel.o[i] > 0) on[i] = Math.log(panel.o[i] / prev);
      }
      const s = rollSum(on, lookback);
      const sd = rollStd(on, lookback);
      const out = NA(panel.n);
      for (let i = 0; i < panel.n; i++) if (sd[i] > 0) out[i] = s[i] / (sd[i] * Math.sqrt(lookback));
      return out;
    },
  };
}

/** Intraday (open-to-close) accumulation, the complement of overnightDrift. */
function intradayDrift(lookback: number): IndicatorCandidate {
  return {
    name: `intraday_${lookback}`,
    family: 'overnight/intraday split',
    warmup: lookback + 2,
    compute(panel) {
      const id = new Float64Array(panel.n).fill(NaN);
      for (let i = 0; i < panel.n; i++) {
        if (panel.o[i] > 0 && panel.c[i] > 0) id[i] = Math.log(panel.c[i] / panel.o[i]);
      }
      const s = rollSum(id, lookback);
      const sd = rollStd(id, lookback);
      const out = NA(panel.n);
      for (let i = 0; i < panel.n; i++) if (sd[i] > 0) out[i] = s[i] / (sd[i] * Math.sqrt(lookback));
      return out;
    },
  };
}

/** Close location value, volume-weighted and accumulated (Chaikin-style). */
function moneyFlow(lookback: number): IndicatorCandidate {
  return {
    name: `mfi_${lookback}`,
    family: 'money flow',
    warmup: lookback + 2,
    compute(panel) {
      const flow = new Float64Array(panel.n).fill(NaN);
      for (let i = 0; i < panel.n; i++) {
        const span = panel.h[i] - panel.l[i];
        flow[i] = span > 0 ? (((panel.c[i] - panel.l[i]) - (panel.h[i] - panel.c[i])) / span) * panel.v[i] : 0;
      }
      const s = rollSum(flow, lookback);
      const vol = rollSum(panel.v, lookback);
      const out = NA(panel.n);
      for (let i = 0; i < panel.n; i++) if (vol[i] > 0) out[i] = s[i] / vol[i];
      return out;
    },
  };
}

/** Relative volume: today's turnover against its own trailing norm. */
function volumeShock(lookback: number): IndicatorCandidate {
  return {
    name: `volshock_${lookback}`,
    family: 'volume shock',
    warmup: lookback + 2,
    compute(panel) {
      const lv = new Float64Array(panel.n).fill(NaN);
      for (let i = 0; i < panel.n; i++) if (panel.v[i] > 0) lv[i] = Math.log(panel.v[i]);
      const z = zScore(lv, lookback);
      const r = logReturns(panel.c);
      const sd = rollStd(r, lookback);
      const out = NA(panel.n);
      // Signed by the move the volume arrived on: a volume spike is not
      // directional on its own, so it is carried as confirmation of the day's
      // return rather than as a signal in itself.
      for (let i = 0; i < panel.n; i++) {
        if (Number.isFinite(z[i]) && Number.isFinite(r[i]) && sd[i] > 0) out[i] = z[i] * (r[i] / sd[i]);
      }
      return out;
    },
  };
}

/** Residual momentum: momentum of the benchmark-neutral return stream. */
function residualMomentum(lookback: number, skip: number): IndicatorCandidate {
  return {
    name: `resmom_${lookback}_${skip}`,
    family: 'residual momentum',
    warmup: lookback + skip + 130,
    compute(panel, market) {
      const r = logReturns(panel.c);
      const br = alignedBenchReturns(panel, market);
      const { beta, alpha } = rollRegression(r, br, 126);
      const resid = new Float64Array(panel.n).fill(NaN);
      for (let i = 0; i < panel.n; i++) {
        if (Number.isFinite(beta[i]) && Number.isFinite(r[i]) && Number.isFinite(br[i])) {
          resid[i] = r[i] - alpha[i] - beta[i] * br[i];
        }
      }
      const s = rollSum(resid, lookback);
      const sd = rollStd(resid, lookback);
      const out = NA(panel.n);
      for (let i = skip; i < panel.n; i++) {
        const j = i - skip;
        if (Number.isFinite(s[j]) && sd[j] > 0) out[i] = s[j] / (sd[j] * Math.sqrt(lookback));
      }
      return out;
    },
  };
}

/** Beta against the benchmark, negated: the low-beta anomaly. */
function lowBeta(lookback: number): IndicatorCandidate {
  return {
    name: `lowbeta_${lookback}`,
    family: 'low beta',
    warmup: lookback + 2,
    compute(panel, market) {
      const r = logReturns(panel.c);
      const br = alignedBenchReturns(panel, market);
      const { beta } = rollRegression(r, br, lookback);
      const out = NA(panel.n);
      for (let i = 0; i < panel.n; i++) if (Number.isFinite(beta[i])) out[i] = -beta[i];
      return out;
    },
  };
}

/** Volatility compression: a quiet range against its own norm. */
function volatilityCompression(short: number, long: number): IndicatorCandidate {
  return {
    name: `squeeze_${short}_${long}`,
    family: 'volatility compression',
    warmup: long + 2,
    compute(panel) {
      const a = atrSeries(panel.h, panel.l, panel.c, short);
      const norm = rollMean(a, long);
      const out = NA(panel.n);
      for (let i = 0; i < panel.n; i++) if (a[i] > 0 && norm[i] > 0) out[i] = -Math.log(a[i] / norm[i]);
      return out;
    },
  };
}

/** Distance from a moving average, in ATR — the stretch a mean-reverter trades. */
function maStretch(lookback: number): IndicatorCandidate {
  return {
    name: `stretch_${lookback}`,
    family: 'MA stretch',
    warmup: lookback + 20,
    compute(panel) {
      const ma = rollMean(panel.c, lookback);
      const a = atrSeries(panel.h, panel.l, panel.c, 14);
      const out = NA(panel.n);
      for (let i = 0; i < panel.n; i++) if (Number.isFinite(ma[i]) && a[i] > 0) out[i] = -(panel.c[i] - ma[i]) / a[i];
      return out;
    },
  };
}

/** Return skewness over the window, negated: preference for lottery payoffs. */
function returnSkew(lookback: number): IndicatorCandidate {
  return {
    name: `skew_${lookback}`,
    family: 'return skew',
    warmup: lookback + 2,
    compute(panel) {
      const r = logReturns(panel.c);
      const m = rollMean(r, lookback);
      const sd = rollStd(r, lookback);
      const out = NA(panel.n);
      for (let i = lookback; i < panel.n; i++) {
        if (!(sd[i] > 0) || !Number.isFinite(m[i])) continue;
        let s = 0, cnt = 0;
        for (let k = i - lookback + 1; k <= i; k++) {
          if (!Number.isFinite(r[k])) { cnt = 0; break; }
          s += ((r[k] - m[i]) / sd[i]) ** 3; cnt++;
        }
        if (cnt === lookback) out[i] = -s / lookback;
      }
      return out;
    },
  };
}

/** Trend persistence: share of up bars, centred on a coin flip. */
function upDayShare(lookback: number): IndicatorCandidate {
  return {
    name: `updays_${lookback}`,
    family: 'trend persistence',
    warmup: lookback + 2,
    compute(panel) {
      const up = new Float64Array(panel.n).fill(NaN);
      for (let i = 1; i < panel.n; i++) up[i] = panel.c[i] > panel.c[i - 1] ? 1 : 0;
      const m = rollMean(up, lookback);
      const out = NA(panel.n);
      for (let i = 0; i < panel.n; i++) if (Number.isFinite(m[i])) out[i] = m[i] - 0.5;
      return out;
    },
  };
}

/** Drawdown from the trailing peak, in ATR. Positive = deeper drawdown. */
function drawdownDepth(lookback: number): IndicatorCandidate {
  return {
    name: `ddepth_${lookback}`,
    family: 'drawdown depth',
    warmup: lookback + 20,
    compute(panel) {
      const peak = rollMax(panel.c, lookback);
      const a = atrSeries(panel.h, panel.l, panel.c, 14);
      const out = NA(panel.n);
      for (let i = 0; i < panel.n; i++) if (peak[i] > 0 && a[i] > 0) out[i] = (peak[i] - panel.c[i]) / a[i];
      return out;
    },
  };
}

/** Momentum acceleration: the short lookback minus the long one. */
function acceleration(shortLb: number, longLb: number): IndicatorCandidate {
  return {
    name: `accel_${shortLb}_${longLb}`,
    family: 'acceleration',
    warmup: longLb + 2,
    compute(panel) {
      const r = logReturns(panel.c);
      const sd = rollStd(r, longLb);
      const out = NA(panel.n);
      for (let i = longLb; i < panel.n; i++) {
        const s = Math.log(panel.c[i] / panel.c[i - shortLb]) / shortLb;
        const l = Math.log(panel.c[i] / panel.c[i - longLb]) / longLb;
        if (sd[i] > 0) out[i] = (s - l) / sd[i];
      }
      return out;
    },
  };
}


// ── centering, and the conditional families ────────────────────────────────

/**
 * Wrap a candidate so its output is a z-score against its OWN trailing
 * distribution.
 *
 * Several natural constructions are structurally one-sided: drawdown depth is
 * never negative, distance-below-the-high never positive, volatility and
 * illiquidity are strictly positive levels. As raw signals they vote the same
 * direction on every bar of every symbol, and their measured accuracy is then
 * nothing but a readout of how often the market went up — `ddepth_63` scored
 * 56.4% raw and 49.5% once the market's own move was removed, and `nearhigh_63`
 * scored 44.0% and 49.8%. Both numbers were pure drift.
 *
 * Centering against the symbol's own history turns "this stock is 3 ATR below
 * its high" into "this stock is unusually far below its high FOR THIS STOCK",
 * which is a statement that can be false, and therefore one that can carry
 * information. It also keeps the candidate implementable as a per-symbol factor,
 * since the reference distribution is the symbol's own past.
 */
function centered(inner: IndicatorCandidate, window = 252): IndicatorCandidate {
  return {
    name: `${inner.name}_z`,
    family: inner.family,
    warmup: inner.warmup + window,
    compute(panel, market) {
      return zScore(inner.compute(panel, market), window);
    },
  };
}

/**
 * One signal gated by a regime state: `base` is emitted only where `state` is in
 * its own upper (or lower) tail, and zero elsewhere.
 *
 * This is the shape the decay result argues for. Short-horizon reversal was a
 * large effect through 2012 and is absent after; the question that leaves is not
 * whether reversal works but WHEN. A conditional candidate can answer that,
 * where a pure one can only average over states and report the mean of a thing
 * that happens sometimes and not others.
 *
 * Zero rather than NaN outside the gate: zero is an explicit abstention that
 * still counts toward coverage, matching how a factor abstains in the live
 * engine. NaN would silently shrink the cross-section on exactly the dates the
 * regime is calm, biasing every date-level statistic toward turbulent ones.
 */
function conditioned(
  name: string, base: IndicatorCandidate, state: IndicatorCandidate,
  side: 'high' | 'low', threshold = 1,
): IndicatorCandidate {
  return {
    name,
    family: `conditional (${base.family})`,
    warmup: Math.max(base.warmup, state.warmup) + 252,
    compute(panel, market) {
      const b = base.compute(panel, market);
      const z = zScore(state.compute(panel, market), 252);
      const out = new Float64Array(panel.n).fill(NaN);
      for (let i = 0; i < panel.n; i++) {
        if (!Number.isFinite(b[i]) || !Number.isFinite(z[i])) continue;
        const on = side === 'high' ? z[i] >= threshold : z[i] <= -threshold;
        out[i] = on ? b[i] : 0;
      }
      return out;
    },
  };
}

/** Realised volatility as a state variable (uncentred; `conditioned` z-scores it). */
function volState(lookback: number): IndicatorCandidate {
  return {
    name: `volstate_${lookback}`,
    family: 'state',
    warmup: lookback + 2,
    compute(panel) {
      return rollStd(logReturns(panel.c), lookback);
    },
  };
}

/** Turnover as a state variable. */
function volumeState(lookback: number): IndicatorCandidate {
  return {
    name: `volumestate_${lookback}`,
    family: 'state',
    warmup: lookback + 2,
    compute(panel) {
      const lv = new Float64Array(panel.n).fill(NaN);
      for (let i = 0; i < panel.n; i++) if (panel.v[i] > 0) lv[i] = Math.log(panel.v[i]);
      return zScore(lv, lookback);
    },
  };
}

/** The market's implied volatility, as a state shared by every symbol. */
function vixState(): IndicatorCandidate {
  return {
    name: 'vixstate',
    family: 'state',
    warmup: 2,
    compute(panel, market) {
      const out = new Float64Array(panel.n).fill(NaN);
      for (let i = 0; i < panel.n; i++) {
        const d = market.dateIndexOf[i];
        if (d >= 0 && market.vixClose[d] > 0) out[i] = Math.log(market.vixClose[d]);
      }
      return out;
    },
  };
}

/**
 * Overnight gap against the symbol's own gap distribution, negated.
 *
 * Distinct from `overnight_*`, which accumulates a month of gaps as a drift
 * measure. This is the single most recent gap as a dislocation: a name that
 * opened unusually far from its prior close, with the bet that the move
 * overshot.
 */
function gapReversal(window = 63): IndicatorCandidate {
  return {
    name: `gaprev_${window}`,
    family: 'gap reversal',
    warmup: window + 2,
    compute(panel) {
      const gap = new Float64Array(panel.n).fill(NaN);
      for (let i = 1; i < panel.n; i++) {
        if (panel.c[i - 1] > 0 && panel.o[i] > 0) gap[i] = Math.log(panel.o[i] / panel.c[i - 1]);
      }
      const z = zScore(gap, window);
      const out = new Float64Array(panel.n).fill(NaN);
      for (let i = 0; i < panel.n; i++) if (Number.isFinite(z[i])) out[i] = -z[i];
      return out;
    },
  };
}

/**
 * Turn-of-the-month: the last day and first days of a calendar month.
 *
 * A pure calendar effect with no price input at all, included as a control on
 * the whole apparatus as much as for its own sake. It is one of the few
 * documented equity effects with no plausible risk story and it has been
 * measured repeatedly since the 1980s, so a lab that cannot see it is a lab
 * that would miss anything of comparable size.
 */
function turnOfMonth(): IndicatorCandidate {
  return {
    name: 'turnofmonth',
    family: 'seasonality',
    warmup: 2,
    compute(panel) {
      const out = new Float64Array(panel.n).fill(NaN);
      for (let i = 1; i < panel.n; i++) {
        const d = new Date(panel.t[i]);
        const dom = d.getUTCDate();
        const prevMonth = new Date(panel.t[i - 1]).getUTCMonth() !== d.getUTCMonth();
        out[i] = prevMonth || dom <= 3 || dom >= 28 ? 1 : -1;
      }
      return out;
    },
  };
}

/**
 * Downside beta minus upside beta.
 *
 * A name that falls with the market but does not rise with it is carrying an
 * asymmetry that a symmetric beta averages away entirely. Negated, so that
 * LESS downside asymmetry reads as bullish.
 */
function betaAsymmetry(lookback: number): IndicatorCandidate {
  return {
    name: `betaasym_${lookback}`,
    family: 'beta asymmetry',
    warmup: lookback + 2,
    compute(panel, market) {
      const r = logReturns(panel.c);
      const br = alignedBenchReturns(panel, market);
      const out = new Float64Array(panel.n).fill(NaN);
      for (let i = lookback; i < panel.n; i++) {
        let du = 0, dd = 0, nu = 0, nd = 0, su = 0, sd = 0;
        let ok = true;
        for (let k = i - lookback + 1; k <= i; k++) {
          if (!Number.isFinite(r[k]) || !Number.isFinite(br[k])) { ok = false; break; }
          if (br[k] >= 0) { su += r[k] * br[k]; du += br[k] * br[k]; nu++; }
          else { sd += r[k] * br[k]; dd += br[k] * br[k]; nd++; }
        }
        if (!ok || nu < 10 || nd < 10 || du <= 0 || dd <= 0) continue;
        out[i] = -(sd / dd - su / du);
      }
      return out;
    },
  };
}

/**
 * Momentum measured against the BENCHMARK rather than against peers.
 *
 * The reason this exists: plain cross-sectional momentum is the one candidate
 * that holds its sign across every symbol/era cell, but it cannot ship. A
 * `PredictiveFactor` is handed a single symbol, and momentum is a RELATIVE
 * level — "this name is a winner compared with other names" — which one
 * symbol's bars cannot express. Z-scoring against the symbol's own history was
 * the obvious substitute and it destroys the effect outright, because "unusually
 * strong for itself" is a different question with a different answer.
 *
 * Subtracting the benchmark's move over the same window is the one relative
 * construction a single-symbol factor CAN compute, since SPY is an ordinary
 * fetch. It is a coarse stand-in for the peer cross-section — every name is
 * compared with the same reference rather than with its own sector — so whether
 * it retains the effect is a question for measurement, not assumption.
 */
function relativeMomentum(lookback: number, skip: number): IndicatorCandidate {
  return {
    name: `relmom_${lookback}_${skip}`,
    family: 'relative momentum',
    warmup: lookback + skip + 2,
    compute(panel, market) {
      const out = new Float64Array(panel.n).fill(NaN);
      for (let i = lookback + skip; i < panel.n; i++) {
        const a = panel.c[i - lookback - skip], b = panel.c[i - skip];
        const da = market.dateIndexOf[i - lookback - skip], db = market.dateIndexOf[i - skip];
        if (!(a > 0 && b > 0) || da < 0 || db < 0) continue;
        const ba = market.benchClose[da], bb = market.benchClose[db];
        if (!(ba > 0 && bb > 0)) continue;
        out[i] = Math.log(b / a) - Math.log(bb / ba);
      }
      return out;
    },
  };
}

export function candidatePool(): IndicatorCandidate[] {
  return [
    momentum(252, 21), momentum(126, 21), momentum(63, 5), momentum(252, 0), momentum(21, 0),
    riskAdjustedMomentum(252, 21), riskAdjustedMomentum(126, 21), riskAdjustedMomentum(63, 5),
    reversal(5), reversal(10), reversal(21), reversal(63),
    highProximity(252), highProximity(126), highProximity(63),
    donchianPosition(252), donchianPosition(63), donchianPosition(21),
    maxEffect(21), maxEffect(63),
    idiosyncraticVol(63), idiosyncraticVol(126),
    lowVolatility(21), lowVolatility(63),
    illiquidity(21), illiquidity(63),
    efficiencyRatio(21), efficiencyRatio(63), efficiencyRatio(126),
    overnightDrift(21), overnightDrift(63),
    intradayDrift(21), intradayDrift(63),
    moneyFlow(21), moneyFlow(63),
    volumeShock(21), volumeShock(63),
    residualMomentum(252, 21), residualMomentum(126, 21), residualMomentum(21, 0),
    lowBeta(126), lowBeta(252),
    volatilityCompression(14, 126), volatilityCompression(14, 63),
    maStretch(21), maStretch(63), maStretch(126),
    returnSkew(63), returnSkew(126),
    upDayShare(21), upDayShare(63),
    drawdownDepth(63), drawdownDepth(252),
    acceleration(21, 126), acceleration(10, 63),

    // Centred forms of the structurally one-sided families. Their uncentred
    // versions above are kept only so the two can be compared directly.
    // Momentum in its IMPLEMENTABLE form. A `PredictiveFactor` is handed one
    // symbol and must decide bullish or bearish from that alone, so the raw
    // cross-sectional value above cannot ship as-is; the z-scored form asks
    // "is this name's twelve-month momentum unusual FOR THIS NAME", which a
    // single-symbol factor can answer. Both are measured so the cost of the
    // transform is visible rather than assumed.
    centered(momentum(252, 21)), centered(momentum(252, 0)),
    relativeMomentum(252, 21), relativeMomentum(252, 0), relativeMomentum(126, 21),
    centered(highProximity(252)), centered(highProximity(63)),
    centered(drawdownDepth(63)), centered(drawdownDepth(252)),
    centered(maxEffect(21)), centered(idiosyncraticVol(63)),
    centered(lowBeta(126)), centered(illiquidity(63)),

    // Regime-conditioned reversal and momentum. The pure forms decayed after
    // 2012; these ask whether the effect survives inside a state rather than on
    // average across all of them.
    conditioned('rev5_hivol', reversal(5), volState(21), 'high'),
    conditioned('rev5_lovol', reversal(5), volState(21), 'low'),
    conditioned('rev5_hivix', reversal(5), vixState(), 'high'),
    conditioned('rev5_hivolume', reversal(5), volumeState(63), 'high'),
    conditioned('rev21_hivol', reversal(21), volState(21), 'high'),
    conditioned('mom252_lovol', momentum(252, 21), volState(63), 'low'),
    conditioned('mom252_hivix', momentum(252, 21), vixState(), 'high'),
    conditioned('stretch21_hivol', maStretch(21), volState(21), 'high'),

    gapReversal(63), gapReversal(21),
    turnOfMonth(),
    betaAsymmetry(126), betaAsymmetry(252),
  ];
}
