import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import styles from './OptionsMetrics.module.css';

interface GexData {
  strike: number;
  callGex: number;
  putGex: number;
  totalGex: number;
}

interface TermStructureData {
  expiry: string;
  dte: number;
  averageIV: number;
}

interface MetricsResponse {
  symbol: string;
  spotPrice: number;
  maxPainStrike: number;
  maxPainExpiry: string;
  putCallSkew: {
    volumeRatio: number;
    oiRatio: number;
    totalCallVol: number;
    totalPutVol: number;
    totalCallOI: number;
    totalPutOI: number;
  };
  termStructure: TermStructureData[];
  gexProfile: GexData[];
}

interface Props {
  symbol: string;
}

const METRIC_INFO: Record<string, { title: string; description: string }> = {
  maxPain: {
    title: 'Max Pain',
    description: 'The strike price where option holders would lose the most money at expiration. Market makers may gravitate price toward this level as expiry approaches.',
  },
  volumeSkew: {
    title: 'Put/Call Volume Skew',
    description: 'Ratio of put volume to call volume. Values above 1.0 indicate heavier put buying (bearish hedging); below 1.0 suggests call dominance (bullish positioning).',
  },
  oiSkew: {
    title: 'Put/Call OI Skew',
    description: 'Ratio of put open interest to call open interest. Persistent OI skew reveals where institutional positions are concentrated over time.',
  },
  gex: {
    title: 'Gamma Exposure (GEX)',
    description: 'Estimated dealer gamma by strike, computed via Black-Scholes (γ × OI × 100 × spot). Positive GEX (calls) dampens volatility; negative GEX (puts) amplifies it.',
  },
  termStructure: {
    title: 'IV Term Structure',
    description: 'OI-weighted average implied volatility across expirations. An upward slope (contango) is normal; inversion signals near-term event risk or fear.',
  },
};

function MetricTooltip({ metricKey }: { metricKey: keyof typeof METRIC_INFO }) {
  const info = METRIC_INFO[metricKey];
  return (
    <span className={styles.infoIcon} title={`${info.title}: ${info.description}`}>
      ⓘ
    </span>
  );
}

export const OptionsMetrics: React.FC<Props> = ({ symbol }) => {
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol) return;
    let isMounted = true;

    setLoading(true);
    setError(null);

    api.getOptionsMetrics(symbol)
      .then(res => {
        if (!isMounted) return;
        setData(res);
        setLoading(false);
      })
      .catch(err => {
        if (!isMounted) return;
        setError(err.message || 'Failed to load options metrics');
        setLoading(false);
      });

    return () => { isMounted = false; };
  }, [symbol]);

  if (loading) {
    return (
      <div className={styles.loading}>
        <div className={styles.loadingSpinner} />
        Loading institutional metrics...
      </div>
    );
  }

  if (error) {
    return <div className={styles.error}>{error}</div>;
  }

  if (!data) return null;

  let maxAbsGex = 0;
  data.gexProfile.forEach(d => {
    maxAbsGex = Math.max(maxAbsGex, Math.abs(d.callGex), Math.abs(d.putGex));
  });

  const spotVsMaxPain = data.spotPrice > data.maxPainStrike ? 'Above' : 'Below';
  const spotDiff = Math.abs(data.spotPrice - data.maxPainStrike);
  const spotDiffPct = data.maxPainStrike > 0 ? (spotDiff / data.maxPainStrike * 100).toFixed(1) : '0';

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <div>
          <h2 className={styles.pageTitle}>Institutional Options Metrics</h2>
          <p className={styles.pageSubtitle}>{symbol} · Derived from live options chain data</p>
        </div>
      </div>

      <div className={styles.grid}>
        <div className={styles.card}>
          <h3>
            Max Pain (Nearest Expiry)
            <MetricTooltip metricKey="maxPain" />
          </h3>
          <div className={styles.largeValue}>${data.maxPainStrike.toFixed(2)}</div>
          <div className={styles.subValue}>Expiry: {data.maxPainExpiry}</div>
          <div className={styles.subtext}>
            Spot ${data.spotPrice.toFixed(2)} · {spotVsMaxPain} by {spotDiffPct}%
          </div>
          <p className={styles.cardDesc}>{METRIC_INFO.maxPain.description}</p>
        </div>

        <div className={styles.card}>
          <h3>
            Put/Call Volume Skew
            <MetricTooltip metricKey="volumeSkew" />
          </h3>
          <div className={`${styles.largeValue} ${data.putCallSkew.volumeRatio > 1 ? styles.bearish : styles.bullish}`}>
            {data.putCallSkew.volumeRatio.toFixed(2)}×
          </div>
          <div className={styles.subtext}>
            {data.putCallSkew.totalPutVol.toLocaleString()} Puts / {data.putCallSkew.totalCallVol.toLocaleString()} Calls
          </div>
          <p className={styles.cardDesc}>{METRIC_INFO.volumeSkew.description}</p>
        </div>

        <div className={styles.card}>
          <h3>
            Put/Call OI Skew
            <MetricTooltip metricKey="oiSkew" />
          </h3>
          <div className={`${styles.largeValue} ${data.putCallSkew.oiRatio > 1 ? styles.bearish : styles.bullish}`}>
            {data.putCallSkew.oiRatio.toFixed(2)}×
          </div>
          <div className={styles.subtext}>
            {data.putCallSkew.totalPutOI.toLocaleString()} Puts / {data.putCallSkew.totalCallOI.toLocaleString()} Calls
          </div>
          <p className={styles.cardDesc}>{METRIC_INFO.oiSkew.description}</p>
        </div>
      </div>

      <div className={styles.chartsGrid}>
        <div className={styles.chartCard}>
          <h3>
            Gamma Exposure (GEX) Profile
            <MetricTooltip metricKey="gex" />
          </h3>
          <p className={styles.subtext}>Net dealer gamma by strike · Positive = call gamma · Negative = put gamma</p>

          <div className={styles.gexChartContainer}>
            {data.gexProfile.length > 0 && maxAbsGex > 0 ? (
              <svg width="100%" height="250" viewBox={`0 0 ${data.gexProfile.length * 15} 250`} preserveAspectRatio="none">
                <line x1="0" y1="125" x2={data.gexProfile.length * 15} y2="125" stroke="rgba(255,255,255,0.1)" strokeWidth="1" strokeDasharray="4" />
                {data.gexProfile.map((d, i) => {
                  const x = i * 15;
                  const callHeight = (d.callGex / maxAbsGex) * 100;
                  const putHeight = (Math.abs(d.putGex) / maxAbsGex) * 100;

                  return (
                    <g key={d.strike}>
                      {callHeight > 0 && (
                        <rect x={x + 2} y={125 - callHeight} width="10" height={callHeight} fill="#00d4aa" opacity="0.85" rx="1" />
                      )}
                      {putHeight > 0 && (
                        <rect x={x + 2} y={125} width="10" height={putHeight} fill="#ff4d4d" opacity="0.85" rx="1" />
                      )}
                      {i % Math.ceil(data.gexProfile.length / 10) === 0 && (
                        <text x={x + 7} y="240" fill="#6b6b8a" fontSize="10" textAnchor="middle">
                          {d.strike}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            ) : (
              <div className={styles.empty}>No GEX data available</div>
            )}
          </div>
          <p className={styles.cardDesc}>{METRIC_INFO.gex.description}</p>
        </div>

        <div className={styles.chartCard}>
          <h3>
            IV Term Structure
            <MetricTooltip metricKey="termStructure" />
          </h3>
          <p className={styles.subtext}>OI-weighted average implied volatility by expiration</p>

          <div className={styles.termStructureList}>
            {data.termStructure.map(ts => (
              <div key={ts.expiry} className={styles.tsRow}>
                <div className={styles.tsLabel}>
                  {ts.expiry}
                  <span className={styles.tsDte}>({ts.dte}DTE)</span>
                </div>
                <div className={styles.tsBarContainer}>
                  <div
                    className={styles.tsBar}
                    style={{ width: `${Math.min(100, ts.averageIV * 100)}%` }}
                  />
                </div>
                <div className={styles.tsValue}>{(ts.averageIV * 100).toFixed(1)}%</div>
              </div>
            ))}
          </div>
          <p className={styles.cardDesc}>{METRIC_INFO.termStructure.description}</p>
        </div>
      </div>

      <div className={styles.sourcesBar}>
        <span className={styles.sourcesLabel}>Data Sources</span>
        <div className={styles.sourcesList}>
          <a href="https://finance.yahoo.com" target="_blank" rel="noopener noreferrer" className={styles.sourceLink}>
            Yahoo Finance
          </a>
          <span className={styles.sourceSep}>·</span>
          <span className={styles.sourceDetail}>Options chains, OI, volume, IV</span>
          <span className={styles.sourceSep}>·</span>
          <span className={styles.sourceDetail}>GEX computed via Black-Scholes (r=5%, nearest 4 expirations)</span>
          <span className={styles.sourceSep}>·</span>
          <span className={styles.sourceDetail}>Spot price from Yahoo Finance quote API</span>
        </div>
      </div>
    </div>
  );
};
