/**
 * A small expression grammar for machine-invented indicators.
 *
 * The hand-written pool in `candidateIndicators.ts` encodes ideas someone
 * already had. This encodes the SPACE of ideas, so a search can propose forms
 * nobody wrote down — and, just as importantly, so every proposal is a data
 * structure that can be printed, mutated, hashed for deduplication, and checked
 * for look-ahead by the same machinery.
 *
 * THREE PROPERTIES ARE BUILT INTO THE GRAMMAR RATHER THAN CHECKED AFTERWARDS:
 *
 * 1. CAUSALITY. Every window operator reads `[i-w+1 .. i]` and `lag` only
 *    reaches backwards. No node can express a forward reference, so a generated
 *    tree cannot leak the future even by accident. `assertCausal` still runs on
 *    survivors — belt and braces, since a bug in one operator would be invisible
 *    otherwise.
 *
 * 2. SCALE-FREEDOM. The root is always wrapped in a trailing z-score, so a $600
 *    megacap and a $4 miner emit values on the same scale without the indicator
 *    ever seeing the cross-section. That keeps every invented indicator
 *    implementable as a per-symbol `PredictiveFactor`, which is the only form
 *    the engine can actually consume.
 *
 * 3. SELF-NORMALISING SUBTREES. Raw price levels are almost never comparable
 *    across symbols or eras, so the terminal set favours returns, ratios and
 *    ranges over raw prices. A tree that does reach for `close` will usually
 *    have it divided or differenced by something on the way up.
 */

import type { BarPanel } from '../backtest/barCache.js';
import type { IndicatorCandidate, MarketContext } from './indicatorLab.js';
import {
  atrSeries, logReturns, rollMax, rollMean, rollMin, rollStd, rollSum, zScore,
} from './indicatorPrimitives.js';

/** Windows the search may choose from. Trading-calendar shaped, not arbitrary. */
export const WINDOWS = [3, 5, 10, 21, 42, 63, 126, 252] as const;

export type Terminal =
  | 'close' | 'open' | 'high' | 'low' | 'volume'
  | 'ret' | 'range' | 'atr' | 'benchRet' | 'gap' | 'body';

export type UnaryOp = 'mean' | 'std' | 'min' | 'max' | 'sum' | 'z' | 'delta' | 'lag' | 'rankw';
export type ScalarOp = 'sign' | 'abs' | 'neg' | 'logp';
export type BinaryOp = 'add' | 'sub' | 'mul' | 'div';

export type Expr =
  | { kind: 'term'; name: Terminal }
  | { kind: 'win'; op: UnaryOp; w: number; a: Expr }
  | { kind: 'un'; op: ScalarOp; a: Expr }
  | { kind: 'bin'; op: BinaryOp; a: Expr; b: Expr };

/** Human-readable form. Doubles as the dedup key — structurally equal trees print equal. */
export function render(e: Expr): string {
  switch (e.kind) {
    case 'term': return e.name;
    case 'win': return `${e.op}${e.w}(${render(e.a)})`;
    case 'un': return `${e.op}(${render(e.a)})`;
    case 'bin': return `(${render(e.a)} ${({ add: '+', sub: '-', mul: '*', div: '/' } as const)[e.op]} ${render(e.b)})`;
  }
}

export function depth(e: Expr): number {
  switch (e.kind) {
    case 'term': return 1;
    case 'win': case 'un': return 1 + depth(e.a);
    case 'bin': return 1 + Math.max(depth(e.a), depth(e.b));
  }
}

export function nodeCount(e: Expr): number {
  switch (e.kind) {
    case 'term': return 1;
    case 'win': case 'un': return 1 + nodeCount(e.a);
    case 'bin': return 1 + nodeCount(e.a) + nodeCount(e.b);
  }
}

/** Longest window anywhere in the tree — the warmup the candidate needs. */
export function maxWindow(e: Expr): number {
  switch (e.kind) {
    case 'term': return 0;
    case 'win': return e.w + maxWindow(e.a);
    case 'un': return maxWindow(e.a);
    case 'bin': return Math.max(maxWindow(e.a), maxWindow(e.b));
  }
}

// ── evaluation ─────────────────────────────────────────────────────────────

const NA = (n: number) => new Float64Array(n).fill(NaN);

function terminal(name: Terminal, panel: BarPanel, market: MarketContext): Float64Array {
  const n = panel.n;
  switch (name) {
    case 'close': return panel.c as Float64Array;
    case 'open': return panel.o as Float64Array;
    case 'high': return panel.h as Float64Array;
    case 'low': return panel.l as Float64Array;
    case 'volume': return panel.v as Float64Array;
    case 'ret': return logReturns(panel.c);
    case 'range': {
      // Range as a FRACTION of price, not in dollars — a $2 range means
      // something different on a $10 stock and a $900 one.
      const out = NA(n);
      for (let i = 0; i < n; i++) if (panel.c[i] > 0) out[i] = (panel.h[i] - panel.l[i]) / panel.c[i];
      return out;
    }
    case 'atr': {
      const a = atrSeries(panel.h, panel.l, panel.c, 14);
      const out = NA(n);
      for (let i = 0; i < n; i++) if (panel.c[i] > 0) out[i] = a[i] / panel.c[i];
      return out;
    }
    case 'benchRet': {
      const out = NA(n);
      for (let i = 0; i < n; i++) {
        const d = market.dateIndexOf[i];
        if (d >= 0) out[i] = market.benchRet[d];
      }
      return out;
    }
    case 'gap': {
      const out = NA(n);
      for (let i = 1; i < n; i++) {
        if (panel.c[i - 1] > 0 && panel.o[i] > 0) out[i] = Math.log(panel.o[i] / panel.c[i - 1]);
      }
      return out;
    }
    case 'body': {
      // Where the close sits inside the bar's range: +0.5 at the high, -0.5 at
      // the low. Unit-free and bounded, so it composes safely.
      const out = NA(n);
      for (let i = 0; i < n; i++) {
        const span = panel.h[i] - panel.l[i];
        if (span > 0) out[i] = (panel.c[i] - panel.l[i]) / span - 0.5;
      }
      return out;
    }
  }
}

/** Rank of x[i] within its trailing window, centred on zero. */
function rankWindow(xs: Float64Array, w: number): Float64Array {
  const n = xs.length;
  const out = NA(n);
  for (let i = w - 1; i < n; i++) {
    const v = xs[i];
    if (!Number.isFinite(v)) continue;
    let below = 0, seen = 0, ok = true;
    for (let k = i - w + 1; k <= i; k++) {
      if (!Number.isFinite(xs[k])) { ok = false; break; }
      if (xs[k] < v) below++;
      seen++;
    }
    if (ok && seen > 1) out[i] = below / (seen - 1) - 0.5;
  }
  return out;
}

const EPS = 1e-12;

export function evaluate(e: Expr, panel: BarPanel, market: MarketContext): Float64Array {
  switch (e.kind) {
    case 'term': return terminal(e.name, panel, market);
    case 'win': {
      const a = evaluate(e.a, panel, market);
      switch (e.op) {
        case 'mean': return rollMean(a, e.w);
        case 'std': return rollStd(a, e.w);
        case 'min': return rollMin(a, e.w);
        case 'max': return rollMax(a, e.w);
        case 'sum': return rollSum(a, e.w);
        case 'z': return zScore(a, e.w);
        case 'rankw': return rankWindow(a, e.w);
        case 'delta': {
          const out = NA(a.length);
          for (let i = e.w; i < a.length; i++) out[i] = a[i] - a[i - e.w];
          return out;
        }
        case 'lag': {
          const out = NA(a.length);
          for (let i = e.w; i < a.length; i++) out[i] = a[i - e.w];
          return out;
        }
      }
      break;
    }
    case 'un': {
      const a = evaluate(e.a, panel, market);
      const out = NA(a.length);
      for (let i = 0; i < a.length; i++) {
        const v = a[i];
        if (!Number.isFinite(v)) continue;
        out[i] = e.op === 'sign' ? Math.sign(v)
          : e.op === 'abs' ? Math.abs(v)
          : e.op === 'neg' ? -v
          // log of a possibly-negative quantity, kept finite and sign-preserving.
          : Math.sign(v) * Math.log1p(Math.abs(v));
      }
      return out;
    }
    case 'bin': {
      const a = evaluate(e.a, panel, market);
      const b = evaluate(e.b, panel, market);
      const n = Math.min(a.length, b.length);
      const out = NA(n);
      for (let i = 0; i < n; i++) {
        const x = a[i], y = b[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (e.op === 'add') out[i] = x + y;
        else if (e.op === 'sub') out[i] = x - y;
        else if (e.op === 'mul') out[i] = x * y;
        // Guarded division: a near-zero denominator would otherwise manufacture
        // enormous outliers that dominate every rank the indicator produces.
        else out[i] = Math.abs(y) < EPS ? NaN : x / y;
      }
      return out;
    }
  }
  return NA(panel.n);
}

/** Z-score window applied at the root, making every candidate cross-comparable. */
export const ROOT_Z_WINDOW = 252;

export function toCandidate(e: Expr, name: string): IndicatorCandidate {
  const warm = Math.min(maxWindow(e) + ROOT_Z_WINDOW + 5, 1500);
  return {
    name,
    family: 'invented',
    warmup: warm,
    compute: (panel, market) => zScore(evaluate(e, panel, market), ROOT_Z_WINDOW),
  };
}

// ── random generation and mutation ─────────────────────────────────────────

/** Deterministic LCG. A search that cannot be replayed cannot be audited. */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number { this.s = (this.s * 1664525 + 1013904223) >>> 0; return this.s / 4294967296; }
  pick<T>(xs: readonly T[]): T { return xs[Math.floor(this.next() * xs.length)]; }
  chance(p: number): boolean { return this.next() < p; }
}

const TERMINALS: Terminal[] = ['close', 'open', 'high', 'low', 'volume', 'ret', 'range', 'atr', 'benchRet', 'gap', 'body'];
const WIN_OPS: UnaryOp[] = ['mean', 'std', 'min', 'max', 'sum', 'z', 'delta', 'lag', 'rankw'];
const SCALAR_OPS: ScalarOp[] = ['sign', 'abs', 'neg', 'logp'];
const BIN_OPS: BinaryOp[] = ['add', 'sub', 'mul', 'div'];

export function randomExpr(rng: Rng, maxDepth = 4): Expr {
  if (maxDepth <= 1 || rng.chance(0.22)) return { kind: 'term', name: rng.pick(TERMINALS) };
  const roll = rng.next();
  if (roll < 0.45) {
    return { kind: 'win', op: rng.pick(WIN_OPS), w: rng.pick(WINDOWS), a: randomExpr(rng, maxDepth - 1) };
  }
  if (roll < 0.6) {
    return { kind: 'un', op: rng.pick(SCALAR_OPS), a: randomExpr(rng, maxDepth - 1) };
  }
  return {
    kind: 'bin', op: rng.pick(BIN_OPS),
    a: randomExpr(rng, maxDepth - 1), b: randomExpr(rng, maxDepth - 1),
  };
}

/** Every subtree, so mutation and crossover can address any node uniformly. */
function nodes(e: Expr): Expr[] {
  switch (e.kind) {
    case 'term': return [e];
    case 'win': case 'un': return [e, ...nodes(e.a)];
    case 'bin': return [e, ...nodes(e.a), ...nodes(e.b)];
  }
}

function replace(e: Expr, target: Expr, sub: Expr): Expr {
  if (e === target) return sub;
  switch (e.kind) {
    case 'term': return e;
    case 'win': return { ...e, a: replace(e.a, target, sub) };
    case 'un': return { ...e, a: replace(e.a, target, sub) };
    case 'bin': return { ...e, a: replace(e.a, target, sub), b: replace(e.b, target, sub) };
  }
}

/**
 * Point mutation, biased toward small edits.
 *
 * Retuning a window is by far the most common move: the search's job is mostly
 * to find WHICH horizon an idea lives on, and swapping 21 for 63 explores that
 * without discarding a structure that already scored. Wholesale subtree
 * replacement is kept rare so a population does not churn away its progress.
 */
export function mutate(e: Expr, rng: Rng, maxDepth = 4): Expr {
  const all = nodes(e);
  const target = rng.pick(all);
  const roll = rng.next();
  if (target.kind === 'win' && roll < 0.45) {
    return replace(e, target, { ...target, w: rng.pick(WINDOWS) });
  }
  if (target.kind === 'win' && roll < 0.6) {
    return replace(e, target, { ...target, op: rng.pick(WIN_OPS) });
  }
  if (target.kind === 'bin' && roll < 0.7) {
    return replace(e, target, { ...target, op: rng.pick(BIN_OPS) });
  }
  if (target.kind === 'term' && roll < 0.85) {
    return replace(e, target, { kind: 'term', name: rng.pick(TERMINALS) });
  }
  return replace(e, target, randomExpr(rng, Math.max(2, maxDepth - 1)));
}

export function crossover(a: Expr, b: Expr, rng: Rng): Expr {
  const target = rng.pick(nodes(a));
  const donor = rng.pick(nodes(b));
  return replace(a, target, donor);
}
