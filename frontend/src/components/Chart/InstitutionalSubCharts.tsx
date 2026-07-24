import React, { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, LineSeries, HistogramSeries, IChartApi } from 'lightweight-charts';
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
  const skewChartRef = useRef<HTMLDivElement>(null);
  const termChartApi = useRef<IChartApi | null>(null);
  const skewChartApi = useRef<IChartApi | null>(null);

  const [data, setData] = useState<OptionsAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError('');

    api.getOptionsAnalytics(symbol)
      .then(res => { if (mounted) setData(res); })
      .catch(err => { if (mounted) setError(err.message || 'Failed to load analytics'); })
      .finally(() => { if (mounted) setLoading(false); });

    return () => { mounted = false; };
  }, [symbol]);

  // Term structure chart
  useEffect(() => {
    if (!termChartRef.current || !data?.termStructure?.points.length) return;

    if (termChartApi.current) {
      termChartApi.current.remove();
      termChartApi.current = null;
    }

    const chart = createChart(termChartRef.current, {
      width: termChartRef.current.clientWidth,
      height: 140,
      layout: {
        background: { type: ColorType.Solid, color: '#0d1230' },
        textColor: '#a0a0b0',
      },
      grid: {
        vertLines: { color: 'rgba(43, 43, 67, 0.4)' },
        horzLines: { color: 'rgba(43, 43, 67, 0.4)' },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true },
    });

    const series = chart.addSeries(LineSeries, {
      color: stateColor(data.termStructure.state),
      lineWidth: 2,
      crosshairMarkerVisible: true,
    });

    series.setData(
      data.termStructure.points.map(p => ({
        time: p.expiry,
        value: p.averageIV * 100,
      })),
    );

    chart.timeScale().fitContent();
    termChartApi.current = chart;

    const ro = new ResizeObserver(entries => {
      if (entries[0]) chart.applyOptions({ width: entries[0].contentRect.width });
    });
    ro.observe(termChartRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      termChartApi.current = null;
    };
  }, [data?.termStructure]);

  // Skew chart — put vs call IV bars
  useEffect(() => {
    if (!skewChartRef.current || !data?.riskReversal) return;

    if (skewChartApi.current) {
      skewChartApi.current.remove();
      skewChartApi.current = null;
    }

    const chart = createChart(skewChartRef.current, {
      width: skewChartRef.current.clientWidth,
      height: 140,
      layout: {
        background: { type: ColorType.Solid, color: '#0d1230' },
        textColor: '#a0a0b0',
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: 'rgba(43, 43, 67, 0.4)' },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { visible: false },
    });

    const today = new Date().toISOString().split('T')[0]!;
    const putSeries = chart.addSeries(HistogramSeries, { color: '#ff5252' });
    const callSeries = chart.addSeries(HistogramSeries, { color: '#00e676' });

    putSeries.setData([{ time: today, value: data.riskReversal.putIV * 100, color: '#ff5252' }]);
    callSeries.setData([{ time: today, value: data.riskReversal.callIV * 100, color: '#00e676' }]);

    skewChartApi.current = chart;

    const ro = new ResizeObserver(entries => {
      if (entries[0]) chart.applyOptions({ width: entries[0].contentRect.width });
    });
    ro.observe(skewChartRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      skewChartApi.current = null;
    };
  }, [data?.riskReversal]);

  if (loading) {
    return <div className={styles.panel}><div className={styles.status}>Loading institutional signals…</div></div>;
  }

  if (error) {
    return <div className={styles.panel}><div className={styles.error}>{error}</div></div>;
  }

  if (!data) return null;

  const ts = data.termStructure;
  const rr = data.riskReversal;
  const vix = data.vixTermStructure;

  return (
    <div className={styles.panel}>
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
          {ts ? (
            <>
              <div ref={termChartRef} className={styles.chartCanvas} />
              <p className={styles.narrative}>{ts.narrative}</p>
            </>
          ) : (
            <p className={styles.narrativeMuted}>Insufficient expiration data</p>
          )}
        </div>

        <div className={styles.chartBlock}>
          <div className={styles.chartHeader}>
            <span className={styles.chartTitle}>
              25Δ Risk Reversal
              <Explainer metricKey="skew" />
            </span>
            {rr && (
              <span className={styles.badge} style={{ color: rr.bias === 'bearish' ? '#ff5252' : rr.bias === 'bullish' ? '#00e676' : '#ffd740' }}>
                {rr.skew >= 0 ? '+' : ''}{rr.skew.toFixed(1)}pp · {rr.bias}
              </span>
            )}
          </div>
          {rr ? (
            <>
              <div ref={skewChartRef} className={styles.chartCanvas} />
              <p className={styles.narrative}>{rr.narrative}</p>
            </>
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
