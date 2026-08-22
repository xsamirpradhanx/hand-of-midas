import React, { useEffect, useState } from 'react';
import { api, type CentralBankRate, type MacroHeadline, type MacroResponse, type MacroSeries, type RiskGauge } from '../../lib/api';
import styles from './MacroDashboard.module.css';

/**
 * Rates, the curve, and the dollar.
 *
 * Context for a human reading a trade plan, and nothing more. Rate conditioning
 * was measured against 13,679 replayed trades across four decades and showed no
 * stable relationship to outcomes — positive in two decades, negative in two,
 * zero on the full sample — so none of this feeds a signal. The backend states
 * that on the payload and this page renders it rather than dropping it, because
 * a rates panel inside a trading app reads as a signal unless it says otherwise.
 */

/** Percentage-point change, coloured by direction. Yields and spreads are in pp. */
const Change: React.FC<{ label: string; value: number | null }> = ({ label, value }) => {
  // The dead band matters: a yield that moved a tenth of a basis point should
  // not render green. Below half a bp is reported as unchanged.
  const cls = value === null ? styles.flat : value > 0.005 ? styles.up : value < -0.005 ? styles.down : styles.flat;
  return (
    <div className={styles.changeItem}>
      <span className={styles.changeLabel}>{label}</span>
      <span className={`${styles.changeValue} ${cls}`}>
        {value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}`}
      </span>
    </div>
  );
};

/**
 * Sparkline with a soft area fill.
 *
 * Scaled to its own min/max rather than to zero: these series move in tens of
 * basis points on a level of several percent, so a zero-based axis renders
 * every one of them as a flat line. The gradient id is namespaced per series
 * because duplicate SVG ids across cards would make them all adopt whichever
 * gradient the browser resolved first.
 */
const Spark: React.FC<{ id: string; points: Array<{ date: string; value: number }> }> = ({ id, points }) => {
  if (points.length < 2) return null;
  const vals = points.map(p => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const w = 100, h = 40, pad = 3;
  const x = (i: number) => (i / (points.length - 1)) * w;
  const y = (v: number) => h - pad - ((v - min) / span) * (h - pad * 2);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(p.value).toFixed(2)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  const rising = vals[vals.length - 1] >= vals[0];
  const stroke = rising ? 'var(--color-up)' : 'var(--color-down)';
  const gid = `spark-${id}`;
  return (
    <svg className={styles.spark} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} stroke="none" />
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.5" vectorEffect="non-scaling-stroke"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

/**
 * A bank's stance, derived from its own rate path.
 *
 * Reports what the bank HAS DONE. Forward guidance and market-implied
 * expectations have no free machine-readable source, so nothing here claims to
 * know what a bank intends — a distinction worth keeping visible, because a
 * "stance" label invites being read as a forecast.
 */
const Stance: React.FC<{ stance: CentralBankRate['stance'] }> = ({ stance }) => {
  const cls = stance === 'HIKING' ? styles.hiking : stance === 'CUTTING' ? styles.cutting : styles.onhold;
  return <span className={`${styles.stancePill} ${cls}`}>{stance}</span>;
};

/** Compact relative age — "3h ago" reads faster than a timestamp in a feed. */
function timeAgo(epochSeconds: number): string {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - epochSeconds) / 60));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const TAG_CLASS: Record<MacroHeadline['tags'][number], string> = {
  Policy: styles.tagPolicy,
  Geopolitics: styles.tagGeopolitics,
  Currency: styles.tagCurrency,
  Commodities: styles.tagCommodities,
  Data: styles.tagData,
};

/**
 * One headline.
 *
 * Tags say why the item surfaced, not what it means — the filter is keyword
 * matching, so it cannot tell gold bullion from a gold watch. Opens in a new
 * tab with `noopener` since these are third-party wire links.
 */
const Headline: React.FC<{ item: MacroHeadline }> = ({ item }) => (
  <a className={styles.newsItem} href={item.url} target="_blank" rel="noopener noreferrer">
    <span className={styles.newsHead}>{item.headline}</span>
    <span className={styles.newsMeta}>
      <span className={styles.newsSource}>{item.source}</span>
      <span className={styles.newsTime}>{timeAgo(item.datetime)}</span>
      {item.tags.map(t => (
        <span key={t} className={`${styles.tag} ${TAG_CLASS[t] ?? ''}`}>{t}</span>
      ))}
    </span>
  </a>
);

const RISK_CLASS: Record<RiskGauge['label'], string> = {
  'Extreme Fear': styles.extremeFear,
  Fear: styles.fear,
  Neutral: styles.neutral,
  Greed: styles.greed,
  'Extreme Greed': styles.extremeGreed,
};

/** Colour a component bar on the same red-to-green scale as the composite. */
function barColor(score: number): string {
  if (score < 25) return '#ff1744';
  if (score < 45) return '#ff8a3d';
  if (score <= 55) return 'var(--gold-mid)';
  if (score <= 75) return '#7ed957';
  return 'var(--color-up)';
}

/**
 * Risk appetite, composed from six price spreads rather than a third-party index.
 *
 * Every component is shown because the composite alone is not interpretable — a
 * 70 driven by calm volatility means something different from a 70 driven by
 * credit. The marker sits at a POSITION on the scale rather than filling it,
 * since the reading is a percentile, not a quantity.
 */
const Gauge: React.FC<{ risk: RiskGauge }> = ({ risk }) => (
  <div className={styles.gauge}>
    <div className={styles.gaugeMain}>
      <span className={`${styles.gaugeScore} ${RISK_CLASS[risk.label]}`}>
        {risk.score === null ? '—' : Math.round(risk.score)}
      </span>
      <span className={`${styles.gaugeLabel} ${RISK_CLASS[risk.label]}`}>{risk.label}</span>
      <div className={styles.gaugeTrack}>
        {risk.score !== null && (
          <span className={styles.gaugeMarker} style={{ left: `${Math.min(100, Math.max(0, risk.score))}%` }} />
        )}
      </div>
      <div className={styles.gaugeScale}><span>FEAR</span><span>GREED</span></div>
    </div>
    <div className={styles.gaugeComponents}>
      {risk.components.map(c => (
        <div key={c.key} className={styles.comp} title={c.description}>
          <span>
            <span className={styles.compLabel}>{c.label}</span>{' '}
            <span className={styles.compDetail}>{c.detail}</span>
          </span>
          <span className={styles.compTrack}>
            {c.score !== null && (
              <span className={styles.compFill} style={{ width: `${c.score}%`, background: barColor(c.score) }} />
            )}
          </span>
          <span className={styles.compScore}>{c.score === null ? '—' : Math.round(c.score)}</span>
        </div>
      ))}
    </div>
  </div>
);

const SeriesCard: React.FC<{ s: MacroSeries; unit: string }> = ({ s, unit }) => (
  <article className={styles.card}>
    <div className={styles.cardHead}>
      <span className={styles.cardId}>{s.id}</span>
      <span className={styles.asOf}>{s.asOf ?? '—'}</span>
    </div>
    <span className={styles.cardValue}>{s.value === null ? '—' : `${s.value.toFixed(2)}${unit}`}</span>
    <span className={styles.cardDesc}>{s.description}</span>
    <div className={styles.changes}>
      <Change label="1D" value={s.change1d} />
      <Change label="1M" value={s.change1m} />
      <Change label="1Y" value={s.change1y} />
    </div>
    <Spark id={s.id} points={s.history} />
  </article>
);

export const MacroDashboard: React.FC = () => {
  const [data, setData] = useState<MacroResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getMacro()
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e?.message ?? 'Failed to load macro data'); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <div className={styles.state}>Could not load macro data: {error}</div>;
  if (!data) return <div className={styles.state}>Loading rates and currencies…</div>;

  const inverted = data.curveStatus.startsWith('Inverted');

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1 className={styles.title}>Rates &amp; Currencies</h1>
        <p className={styles.subtitle}>
          US policy and market rates from FRED, with the dollar and major crosses
        </p>
      </header>

      <div className={`${styles.curveBanner} ${inverted ? styles.inverted : ''}`}>
        <span className={styles.curveLabel}>Yield curve</span>
        <span className={styles.curveText}>{data.curveStatus}</span>
      </div>

      {data.risk && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Risk appetite</h2>
          <Gauge risk={data.risk} />
          <p className={styles.legend}>{data.risk.note}</p>
        </section>
      )}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Policy &amp; market rates</h2>
        <div className={styles.grid}>
          {data.rates.map(s => <SeriesCard key={s.id} s={s} unit="%" />)}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Term spreads</h2>
        <div className={styles.grid}>
          {data.curve.map(s => <SeriesCard key={s.id} s={s} unit="pp" />)}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Real yields &amp; breakevens</h2>
        <div className={styles.grid}>
          {data.inflation.map(s => <SeriesCard key={s.id} s={s} unit="%" />)}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Central banks</h2>
        <div className={styles.fxPanel}>
          <table className={styles.fxTable}>
            <thead>
              <tr>
                <th>Bank</th><th>Rate</th><th>3M</th><th>12M</th><th>Stance</th><th>Last move</th>
              </tr>
            </thead>
            <tbody>
              {data.banks.map(b => (
                <tr key={b.seriesId}>
                  <td>
                    <div className={styles.bankName}>
                      {b.bank}
                      {!b.official && <span className={styles.proxyMark} title="Market proxy — tracks the policy rate but is not the announced rate"> *</span>}
                      {b.staleDays !== null && b.staleDays > 45 && (
                        <span className={styles.staleTag} title={`Latest observation is ${b.staleDays} days old`}>
                          {b.staleDays}d old
                        </span>
                      )}
                    </div>
                    <div className={styles.bankRegion}>{b.region}</div>
                  </td>
                  <td className={styles.fxNum}>{b.rate === null ? '—' : `${b.rate.toFixed(2)}%`}</td>
                  <td className={`${styles.fxChange} ${
                    b.change3m === null ? styles.flat : b.change3m > 0.005 ? styles.up : b.change3m < -0.005 ? styles.down : styles.flat
                  }`}>{b.change3m === null ? '—' : `${b.change3m >= 0 ? '+' : ''}${b.change3m.toFixed(2)}`}</td>
                  <td className={`${styles.fxChange} ${
                    b.change12m === null ? styles.flat : b.change12m > 0.005 ? styles.up : b.change12m < -0.005 ? styles.down : styles.flat
                  }`}>{b.change12m === null ? '—' : `${b.change12m >= 0 ? '+' : ''}${b.change12m.toFixed(2)}`}</td>
                  <td style={{ textAlign: 'right' }}><Stance stance={b.stance} /></td>
                  <td className={styles.lastMove} style={{ textAlign: 'right' }}>
                    {b.lastChangeDate === null
                      ? '—'
                      : `${b.lastChangeDelta! >= 0 ? '+' : ''}${b.lastChangeDelta!.toFixed(2)} · ${b.lastChangeDate}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.banks.some(b => !b.official) && (
          <p className={styles.legend}>
            <span className={styles.proxyMark}>*</span> market proxy — an overnight rate that tracks the
            policy rate closely but is not the announced rate. Stance is derived from the observed rate
            path, so it reports what a bank has done rather than what it intends.
          </p>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Currencies</h2>
        <div className={styles.fxPanel}>
          <table className={styles.fxTable}>
            <thead>
              <tr><th>Pair</th><th>Price</th><th>Change</th></tr>
            </thead>
            <tbody>
              {data.fx.map(f => (
                <tr key={f.symbol}>
                  <td className={styles.fxPair}>{f.label}</td>
                  <td className={styles.fxNum}>
                    {f.price === null ? '—' : f.price.toFixed(f.price > 20 ? 2 : 4)}
                  </td>
                  <td className={`${styles.fxChange} ${
                    f.changePct === null ? styles.flat : f.changePct > 0 ? styles.up : f.changePct < 0 ? styles.down : styles.flat
                  }`}>
                    {f.changePct === null ? '—' : `${f.changePct >= 0 ? '+' : ''}${f.changePct.toFixed(2)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Macro &amp; geopolitical headlines</h2>
        <div className={styles.fxPanel}>
          {data.headlines.length === 0 ? (
            <p className={styles.newsEmpty}>No macro-relevant headlines in the current feed.</p>
          ) : (
            <div className={styles.newsList}>
              {data.headlines.map(h => <Headline key={h.id} item={h} />)}
            </div>
          )}
        </div>
        <p className={styles.legend}>
          Filtered from a general business wire by keyword, newest first. Tags indicate why an item
          matched, not what it implies — headlines are not scored and feed nothing.
        </p>
      </section>

      <p className={styles.note}>
        <span className={styles.noteBadge}>Context</span>
        <span>{data.note}</span>
      </p>
    </div>
  );
};

export default MacroDashboard;
