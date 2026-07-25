import React, { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, LineSeries, IChartApi } from 'lightweight-charts';
import { api } from '../../lib/api';
import type { OptionsAnalyticsResponse } from '../../types';
import styles from './InstitutionalSubCharts.module.css';

interface Props {
  symbol: string;
}

const EXPLAINERS = {
  skew: {
    title: '25Δ Risk Reversal Skew',
    body: 'Compares OTM put IV to OTM call IV at ~25 delta. Put IV > Call IV signals institutional crash protection (bearish skew). Formula: Skew = Put IV − Call IV.',
  },
  termStructure: {
    title: 'IV Term Structure',
    body: 'Near-term vs far-term implied volatility. Backwardation (near > far) indicates short-term panic and widens ATR stop bounds. Contango is the normal, orderly state.',
  },
};

function Explainer({ metricKey }: { metricKey: keyof typeof EXPLAINERS }) {
  const info = EXPLAINERS[metricKey];
  return (
    <span className={styles.infoIcon} title={`${info.title}: ${info.body}`}>
      ⓘ
    </span>
  );
}

function stateColor(state: string): string {
  if (state === 'backwardation') return '#ff5252';
  if (state === 'contango') return '#00e676';
  if (state === 'kinked') return '#ff9800';
  return '#ffd740';
}

export const InstitutionalSubCharts: React.FC<Props> = ({ symbol }) => {
  const termChartRef = useRef<HTMLDivElement>(null);
  const termChartApi = useRef<IChartApi | null>(null);

  const [data, setData] = useState<OptionsAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError('');

    api.getOptionsAnalytics(symbol)
      .then(res => { if (mounted) setData(res); })
      .catch(err => { if (mounted) setError(err.message || 'No options analytics'); })
      .finally(() => { if (mounted) setLoading(false); });

    return () => { mounted = false; };
  }, [symbol]);

  // Term structure chart
  useEffect(() => {
    if (!termChartRef.current || !data?.termStructure?.points?.length) return;

    if (termChartApi.current) {
      termChartApi.current.remove();
      termChartApi.current = null;
    }

    // Ensure points are sorted by expiry ascending and valid
    const sortedPoints = [...data.termStructure.points]
      .filter(p => p.expiry && !isNaN(p.averageIV))
      .sort((a, b) => a.expiry.localeCompare(b.expiry));

    if (sortedPoints.length === 0) return;

    const chart = createChart(termChartRef.current, {
      width: termChartRef.current.clientWidth || 300,
      height: 140,
      layout: {
        background: { type: ColorType.Solid, color: '#0d1230' },
        textColor: '#a0a0b0',
      },
      grid: {
        vertLines: { color: 'rgba(43, 43, 67, 0.4)' },
        horzLines: { color: 'rgba(43, 43, 67, 0.4)' },
      },
      rightPriceScale: {
        borderVisible: false,
      },
      timeScale: { borderVisible: false, timeVisible: true },
    });

    const series = chart.addSeries(LineSeries, {
      color: stateColor(data.termStructure.state),
      lineWidth: 2,
      crosshairMarkerVisible: true,
      priceFormat: {
        type: 'custom',
        formatter: (val: number) => `${val.toFixed(1)}%`,
      },
    });

    series.setData(
      sortedPoints.map(p => ({
        time: p.expiry,
        value: p.averageIV * 100,
      })),
    );

    chart.timeScale().fitContent();
    termChartApi.current = chart;

    const ro = new ResizeObserver(() => {
      if (!termChartRef.current) return;
      const rect = termChartRef.current.getBoundingClientRect();
      if (rect.width > 0) {
        const logicalRange = chart.timeScale().getVisibleLogicalRange();
        const wasFitted = logicalRange !== null && logicalRange.from <= 0;

        chart.applyOptions({ width: rect.width });

        if (wasFitted) {
          chart.timeScale().fitContent();
        }
      }
    });
    ro.observe(termChartRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      termChartApi.current = null;
    };
  }, [data?.termStructure]);

  if (loading) {
    return <div className={styles.panel}><div className={styles.status}>Loading options volatility signals…</div></div>;
  }

  if (error || !data || (!data.termStructure && !data.riskReversal)) {
    return (
      <div className={styles.panel}>
        <div className={styles.fallbackNotice}>
          <span>💡 <strong>Options Volatility Signals:</strong> No options analytics available for {symbol}. (Institutional volatility metrics are derived from liquid options chains).</span>
        </div>
      </div>
    );
  }

  const ts = data.termStructure;
  const rr = data.riskReversal;
  const vix = data.vixTermStructure;

  // Calculate visual skew ratios for the meter
  const putIvPct = rr ? Math.round(rr.putIV * 100) : 0;
  const callIvPct = rr ? Math.round(rr.callIV * 100) : 0;
  const totalIv = putIvPct + callIvPct || 1;
  const putBarWidth = Math.min(90, Math.max(10, (putIvPct / totalIv) * 100));
  const callBarWidth = 100 - putBarWidth;

  return (
    <div className={styles.panel}>
      <div className={styles.panelTitleBar}>
        <span className={styles.panelCategoryTag}>🎯 OPTIONS MARKET VOLATILITY SIGNALS</span>
      </div>

      <div className={styles.grid}>
        <div className={styles.chartBlock}>
          <div className={styles.chartHeader}>
            <span className={styles.chartTitle}>
              IV Term Structure
              <Explainer metricKey="termStructure" />
            </span>
            {ts && (
              <span className={styles.badge} style={{ color: stateColor(ts.state) }}>
                {ts.state.toUpperCase()} · {ts.slopeRatio.toFixed(2)}×
              </span>
            )}
          </div>
          {ts && ts.points.length >= 2 ? (
            <>
              <div ref={termChartRef} className={styles.chartCanvas} />
              <p className={styles.narrative}>{ts.narrative}</p>
            </>
          ) : (
            <p className={styles.narrativeMuted}>Insufficient expiration points</p>
          )}
        </div>

        <div className={styles.chartBlock}>
          <div className={styles.chartHeader}>
            <span className={styles.chartTitle}>
              25Δ Risk Reversal Skew
              <Explainer metricKey="skew" />
            </span>
            {rr && (
              <span className={styles.badge} style={{ color: rr.bias === 'bearish' ? '#ff5252' : rr.bias === 'bullish' ? '#00e676' : '#ffd740' }}>
                {rr.skew >= 0 ? '+' : ''}{rr.skew.toFixed(1)}pp · {rr.bias.toUpperCase()}
              </span>
            )}
          </div>
          {rr ? (
            <div className={styles.skewContainer}>
              <div className={styles.skewMetricsRow}>
                <div className={styles.skewCard} style={{ borderColor: 'rgba(255, 82, 82, 0.3)' }}>
                  <span className={styles.skewLabel}>25Δ PUT IV</span>
                  <span className={styles.skewValue} style={{ color: '#ff5252' }}>{(rr.putIV * 100).toFixed(1)}%</span>
                  <span className={styles.skewSub}>Strike ${rr.putStrike}</span>
                </div>
                <div className={styles.skewCard} style={{ borderColor: 'rgba(0, 230, 118, 0.3)' }}>
                  <span className={styles.skewLabel}>25Δ CALL IV</span>
                  <span className={styles.skewValue} style={{ color: '#00e676' }}>{(rr.callIV * 100).toFixed(1)}%</span>
                  <span className={styles.skewSub}>Strike ${rr.callStrike}</span>
                </div>
              </div>

              <div className={styles.skewMeterBlock}>
                <div className={styles.skewMeterTrack}>
                  <div className={styles.skewPutBar} style={{ width: `${putBarWidth}%` }} title={`Put IV ${putIvPct}%`} />
                  <div className={styles.skewCallBar} style={{ width: `${callBarWidth}%` }} title={`Call IV ${callIvPct}%`} />
                </div>
                <div className={styles.skewMeterLegend}>
                  <span style={{ color: '#ff5252' }}>Put Demand</span>
                  <span className={styles.skewDiffText}>
                    {rr.skew > 0 ? `+${rr.skew.toFixed(1)}pp Put Skew` : `${rr.skew.toFixed(1)}pp Call Skew`}
                  </span>
                  <span style={{ color: '#00e676' }}>Call Demand</span>
                </div>
              </div>

              <p className={styles.narrative}>{rr.narrative}</p>
            </div>
          ) : (
            <p className={styles.narrativeMuted}>25Δ contracts not found</p>
          )}
        </div>
      </div>

      {(vix || data.gex) && (
        <div className={styles.footer}>
          {vix && (
            <span className={styles.footerItem}>
              VIX term structure: <strong style={{ color: stateColor(vix.state) }}>{vix.state}</strong>
              {vix.state === 'backwardation' && ' — macro panic elevated'}
              {vix.state === 'kinked' && ' — event risk elevated'}
            </span>
          )}
          {data.gex && (
            <span className={styles.footerItem}>
              Dealer GEX (OI Proxy): 
              Flip: <strong>{data.gex.gammaFlipStrike > 0 ? `$${data.gex.gammaFlipStrike.toFixed(2)}` : 'None'}</strong>
              {' · '}Pin: <strong>${data.gex.maxAbsGexStrike.toFixed(2)}</strong>
            </span>
          )}
        </div>
      )}
    </div>
  );
};
