import type { OHLCVDataPoint } from '../../types.js';
import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

/**
 * Session-Anchored VWAP Factor (Day / London / US)
 *
 * Modeled on Robert Rother's three-VWAP-line method: track VWAP anchored at
 * three session opens, determine which one price is currently "respecting"
 * (pausing/pulling back at, then continuing), and only take a bias when the
 * session is actually trending — a flat/ranging tape is explicitly a no-trade
 * per his rule, not forced into a directional read.
 *
 * Equities can't replicate the futures anchor exactly: ES/NQ trade ~23h/day so
 * "Day VWAP" anchors at midnight ET (6pm ET globex open). US equities have no
 * overnight session, so the closest proxy is the pre-market open (4:00 AM ET) —
 * the earliest bar Schwab/Yahoo extended-hours data reliably returns. Called
 * out explicitly in the reasoning string so this isn't mistaken for the real
 * 24h anchor.
 */

type SessionKey = 'day' | 'london' | 'us';

const SESSION_LABEL: Record<SessionKey, string> = {
  day: 'Day VWAP',
  london: 'London VWAP',
  us: 'US Session VWAP',
};

// Anchor times in ET minutes-since-midnight.
const ANCHOR_MINUTES_ET: Record<SessionKey, number> = {
  day: 4 * 60,        // 4:00 AM ET — pre-market open; equities proxy for the midnight-ET futures anchor
  london: 3 * 60,      // ~3:00 AM ET — London cash open (08:00 London time); can drift ±1h in DST-transition weeks
  us: 9 * 60 + 30,     // 9:30 AM ET — NYSE/Nasdaq regular session open
};

const SESSION_PRIORITY: Record<SessionKey, number> = { day: 3, london: 2, us: 1 };

interface SessionVwapLine {
  key: SessionKey;
  vwap: number;
  upperBand: number;
  lowerBand: number;
  respectCount: number;
}

function toEtParts(isoDatetime: string): { minutesOfDay: number; dayKey: string } {
  const et = new Date(new Date(isoDatetime).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return {
    minutesOfDay: et.getHours() * 60 + et.getMinutes(),
    dayKey: `${et.getFullYear()}-${et.getMonth()}-${et.getDate()}`,
  };
}

function buildLine(key: SessionKey, windowBars: OHLCVDataPoint[]): SessionVwapLine | null {
  if (windowBars.length < 3) return null;

  let cumPV = 0;
  let cumVol = 0;
  for (const b of windowBars) {
    const typicalPrice = (b.high + b.low + b.close) / 3;
    const vol = b.volume || 1;
    cumPV += typicalPrice * vol;
    cumVol += vol;
  }
  if (cumVol === 0) return null;
  const vwap = cumPV / cumVol;

  let cumVariance = 0;
  for (const b of windowBars) {
    const typicalPrice = (b.high + b.low + b.close) / 3;
    const vol = b.volume || 1;
    const diff = typicalPrice - vwap;
    cumVariance += vol * diff * diff;
  }
  const stdDev = Math.sqrt(cumVariance / cumVol);

  // "Respected" = price closed within a tight band of this VWAP and then kept
  // moving in the direction it was already moving in (pause-then-continue),
  // rather than reversing through it. Mechanical stand-in for "where price
  // pauses or pulls back" from a chart-reading standpoint.
  let respectCount = 0;
  if (stdDev > 0) {
    for (let i = 5; i < windowBars.length; i++) {
      const bar = windowBars[i];
      const prevBar = windowBars[i - 1];
      const priorTrend = prevBar.close - windowBars[i - 5].close;
      const afterMove = bar.close - prevBar.close;
      const dist = Math.abs(prevBar.close - vwap);
      if (priorTrend !== 0 && dist < 0.35 * stdDev && Math.sign(afterMove) === Math.sign(priorTrend)) {
        respectCount++;
      }
    }
  }

  return {
    key,
    vwap,
    upperBand: vwap + 2 * stdDev,
    lowerBand: Math.max(0, vwap - 2 * stdDev),
    respectCount,
  };
}

export class SessionVwapFactor implements PredictiveFactor {
  name = 'Session VWAP (Day / London / US)';
  bucket = 'PRICE_STRUCTURE' as const;
  correlationGroup = 'VWAP';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    const { intradayBars, currentPrice } = input;
    if (!intradayBars || intradayBars.length < 15) return null;

    const lastDayKey = toEtParts(intradayBars[intradayBars.length - 1].datetime).dayKey;
    const todaysBars = intradayBars.filter(b => toEtParts(b.datetime).dayKey === lastDayKey);
    if (todaysBars.length < 10) return null;

    // Build one line per session anchor, but collapse anchors that resolve to the
    // same first bar.
    //
    // When a symbol has no pre-market prints — common on thin names — the first
    // available bar of the day is at or after every anchor time, so Day, London and
    // US all start from that same bar and compute an identical VWAP. Reporting them
    // as three separate lines implied three independent reads that agreed, when it
    // was one line printed three times (UWMC: "Day VWAP $1.61 ... London VWAP $1.61,
    // US Session VWAP $1.61"). Deduplicating by anchor bar keeps the strongest
    // session label and says plainly that the others never separated.
    const lines: SessionVwapLine[] = [];
    const collapsedInto = new Map<number, SessionKey>();
    const collapsedAway: SessionKey[] = [];
    for (const key of Object.keys(ANCHOR_MINUTES_ET) as SessionKey[]) {
      const anchorMinutes = ANCHOR_MINUTES_ET[key];
      const anchorIdx = todaysBars.findIndex(b => toEtParts(b.datetime).minutesOfDay >= anchorMinutes);
      if (anchorIdx === -1) continue; // this session's anchor hasn't occurred yet today

      const existing = collapsedInto.get(anchorIdx);
      if (existing !== undefined) {
        // Same starting bar as an anchor already built — identical by construction.
        if (SESSION_PRIORITY[key] > SESSION_PRIORITY[existing]) {
          collapsedAway.push(existing);
          collapsedInto.set(anchorIdx, key);
          const idx = lines.findIndex(l => l.key === existing);
          if (idx !== -1) lines[idx] = { ...lines[idx], key };
        } else {
          collapsedAway.push(key);
        }
        continue;
      }

      const line = buildLine(key, todaysBars.slice(anchorIdx));
      if (line) {
        lines.push(line);
        collapsedInto.set(anchorIdx, key);
      }
    }
    if (lines.length === 0) return null;

    // Most-respected line wins; ties favor the longer-anchored session (Day > London > US),
    // matching Rother's framing of Day VWAP as "most important — contains the most data."
    lines.sort((a, b) => b.respectCount - a.respectCount || SESSION_PRIORITY[b.key] - SESSION_PRIORITY[a.key]);
    const primary = lines[0];
    const dayLine = lines.find(l => l.key === 'day') ?? primary;

    // Trend filter: Rother explicitly avoids sideways/ranging tape — a pullback to
    // VWAP only has continuation edge when a trend already exists. Treat a flat
    // trailing drift as a no-trade instead of forcing a directional bias out of noise.
    const trendWindow = todaysBars.slice(-Math.min(20, todaysBars.length));
    const trendChange = trendWindow[trendWindow.length - 1].close - trendWindow[0].close;
    const trendPct = Math.abs(trendChange) / dayLine.vwap;
    const isRanging = trendPct < 0.0025;

    const bias: 'bullish' | 'bearish' | 'neutral' = isRanging
      ? 'neutral'
      : currentPrice > primary.vwap ? 'bullish' : 'bearish';

    // A factor with no directional read must not vote on price levels. The old
    // fallback here emitted currentPrice * 0.997 / 1.003 — ±0.3%, the tightest
    // targets in the engine — which fed compositeScore's target clustering and
    // dragged T1 to within a fraction of an ATR of spot on high-volatility
    // symbols. When we're sitting out, emit no targets at all.
    const buyTarget = isRanging ? undefined
      : bias === 'bearish' ? primary.lowerBand : primary.vwap;
    const sellTarget = isRanging ? undefined
      : bias === 'bullish' ? primary.upperBand : primary.vwap;

    const otherLines = lines
      .filter(l => l.key !== primary.key)
      .map(l => `${SESSION_LABEL[l.key]} $${l.vwap.toFixed(2)}`)
      .join(', ');

    // Name the anchors that never separated, so a single line is not mistaken for
    // several agreeing ones.
    const collapsedNote = collapsedAway.length === 0
      ? ''
      : ` ${collapsedAway.map(k => SESSION_LABEL[k]).join(' and ')} ${collapsedAway.length > 1 ? 'share' : 'shares'} this anchor — no pre-market prints today, so ${collapsedAway.length > 1 ? 'those sessions' : 'that session'} never separated.`;

    const reasoning = isRanging
      ? `Session is ranging (${(trendPct * 100).toFixed(2)}% drift over the trailing window) — no VWAP pullback-continuation edge, sitting out per trend-only VWAP rules. Day VWAP (anchored at 4:00 AM ET pre-market open, the equities proxy for a midnight-ET futures anchor) is $${dayLine.vwap.toFixed(2)}.`
      : `${SESSION_LABEL[primary.key]} ($${primary.vwap.toFixed(2)}) is the most-respected line (${primary.respectCount} pause/continuation reactions this session). Price is ${bias.toUpperCase()} relative to it.${otherLines ? ` Other lines: ${otherLines}.` : ''}${collapsedNote}`;

    return {
      factorName: this.name,
      buyTarget,
      sellTarget,
      bias,
      weight: isRanging ? 0.05 : 0.30,
      bucket: 'PRICE_STRUCTURE',
      correlationGroup: 'VWAP',
      reasoning,
    };
  }
}
