import React, { useEffect, useState } from 'react';
import { api, type MacroResponse, type MacroSeries } from '../../lib/api';
import styles from './MacroDashboard.module.css';

/**
 * Rates, the curve, and the dollar.
 *
 * Context for a human reading a trade plan, and nothing more. Rate conditioning
 * was measured against 13,679 replayed trades across four decades and showed no
 * stable relationship to outcomes — positive in two decades, negative in two,
 * zero on the full sample — so none of this feeds a signal. The backend says so
 * on the payload and this page renders that statement rather than dropping it,
 * because a rates panel inside a trading app reads as a signal unless it
 * explicitly says it is not one.
 */

/** Percentage-point change, coloured by direction. Yields are quoted in pp. */
const Change: React.FC<{ label: string; value: number | null }> = ({ label, value }) => {
  const cls = value === null ? styles.flat : value > 0.005 ? styles.up : value < -0.005 ? styles.down : styles.flat;
  return (
    <div className={styles.changeItem}>
      <span className={styles.changeLabel}>{label}</span>
      <span className={cls}>{value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}`}</span>
    </div>
  );
};

/**
 * Inline sparkline over the trailing history.
 *
 * Scaled to its own min/max rather than to zero: these series move in tens of
 * basis points on a level of several percent, and a zero-based axis would
 * render every one of them as a flat line.
 */
const Spark: React.FC<{ points: Array<{ date: string; value: number }> }> = ({ points }) => {
  if (points.length < 2) return null;
  const vals = points.map(p => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const w = 100, h = 34;
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${((i / (points.length - 1)) * w).toFixed(2)},${(h - ((p.value - min) / span) * (h - 4) - 2).toFixed(2)}`)
    .join(' ');
  const rising = vals[vals.length - 1] >= vals[0];
  return (
    <svg className={styles.spark} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke"
        stroke={rising ? 'var(--color-bullish, #2ecc71)' : 'var(--color-bearish, #ff5c5c)'} />
    </svg>
  );
};

const SeriesCard: React.FC<{ s: MacroSeries; unit: string }> = ({ s, unit }) => (
  <div className={styles.card}>
    <span className={styles.cardId}>{s.id}</span>
    <span className={styles.cardValue}>{s.value === null ? '—' : `${s.value.toFixed(2)}${unit}`}</span>
    <span className={styles.cardDesc}>{s.description}</span>
    <div className={styles.changes}>
      <Change label="1D" value={s.change1d} />
      <Change label="1M" value={s.change1m} />
      <Change label="1Y" value={s.change1y} />
    </div>
    <Spark points={s.history} />
    <span className={styles.asOf}>as of {s.asOf ?? '—'}</span>
  </div>
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
          US policy and market rates from FRED, with the dollar and major crosses.
        </p>
      </header>

      <div className={`${styles.curveBanner} ${inverted ? styles.inverted : styles.normal}`}>
        {data.curveStatus}
      </div>

      <section>
        <h2 className={styles.sectionTitle}>Policy &amp; market rates</h2>
        <div className={styles.grid}>
          {data.rates.map(s => <SeriesCard key={s.id} s={s} unit="%" />)}
        </div>
      </section>

      <section>
        <h2 className={styles.sectionTitle}>Term spreads</h2>
        <div className={styles.grid}>
          {data.curve.map(s => <SeriesCard key={s.id} s={s} unit="pp" />)}
        </div>
      </section>

      <section>
        <h2 className={styles.sectionTitle}>Real yields &amp; breakevens</h2>
        <div className={styles.grid}>
          {data.inflation.map(s => <SeriesCard key={s.id} s={s} unit="%" />)}
        </div>
      </section>

      <section>
        <h2 className={styles.sectionTitle}>Currencies</h2>
        <table className={styles.fxTable}>
          <thead>
            <tr><th>Pair</th><th>Price</th><th>Change</th></tr>
          </thead>
          <tbody>
            {data.fx.map(f => (
              <tr key={f.symbol}>
                <td>{f.label}</td>
                <td>{f.price === null ? '—' : f.price.toFixed(f.price > 20 ? 2 : 4)}</td>
                <td className={f.changePct === null ? styles.flat : f.changePct > 0 ? styles.up : f.changePct < 0 ? styles.down : styles.flat}>
                  {f.changePct === null ? '—' : `${f.changePct >= 0 ? '+' : ''}${f.changePct.toFixed(2)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className={styles.note}>{data.note}</p>
    </div>
  );
};

export default MacroDashboard;
