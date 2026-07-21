import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import styles from './OptionsMetrics.module.css';

interface GexData {
  strike: number;
  callGex: number;
  putGex: number;
  totalGex: number;
}

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

interface VolumeOIByStrike {
  strike: number;
  callVol: number;
  callOI: number;
  putVol: number;
  putOI: number;
  callVolOI: number;
  putVolOI: number;
  totalVolOI: number;
}

interface OIChange {
  strike: number;
  expiry: string;
  side: 'call' | 'put';
  currentOI: number;
  previousOI: number;
  oiChange: number;
  oiChangePct: number;
}

interface MetricsResponse {
  symbol: string;
  spotPrice: number;
  maxPainStrike: number;
  gammaFlipStrike: number;
  maxPainExpiry: string;
  straddleExpectedMove: number;
  straddleExpectedMovePct: number;
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
  volumeOIByStrike: VolumeOIByStrike[];
  oiChanges: OIChange[];
}

interface Props {
  symbol: string;
  activeExpiry: string | null;
}

const METRIC_INFO: Record<string, { title: string; description: string }> = {
  maxPain: {
    title: 'Max Pain',
    description: 'The strike price where option holders would lose the most money at expiration. Market makers may gravitate price toward this level as expiry approaches.',
  },
  expectedMove: {
    title: 'Expected Move',
    description: 'The implied daily or weekly price move derived from ATM straddle pricing. Indicates the market\'s baseline expectation for volatility.',
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
  gammaFlip: {
    title: 'Gamma Flip Level',
    description: 'The spot price/strike where aggregate dealer Gamma exposure flips from positive to negative. Above this level, dealers suppress volatility (mean-reversion). Below, they amplify it (momentum breakout).',
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

export const OptionsMetrics: React.FC<Props> = ({ symbol, activeExpiry }) => {
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol) return;
    let isMounted = true;

    setLoading(true);
    setError(null);

    api.getOptionsMetrics(symbol, activeExpiry || undefined)
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
  }, [symbol, activeExpiry]);

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
  let totalNetGex = 0;
  let maxGexStrike = 0;
  let maxGexValue = 0;
  data.gexProfile.forEach(d => {
    maxAbsGex = Math.max(maxAbsGex, Math.abs(d.callGex), Math.abs(d.putGex));
    totalNetGex += d.totalGex;
    if (Math.abs(d.totalGex) > Math.abs(maxGexValue)) {
      maxGexValue = d.totalGex;
      maxGexStrike = d.strike;
    }
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
            Max Pain {activeExpiry ? `(${activeExpiry})` : '(Nearest Expiry)'}
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
            Expected Move {activeExpiry ? `(${activeExpiry})` : ''}
            <MetricTooltip metricKey="expectedMove" />
          </h3>
          <div className={styles.largeValue}>±${(data.straddleExpectedMove || 0).toFixed(2)}</div>
          <div className={styles.subtext}>
            Implied ±{(data.straddleExpectedMovePct * 100 || 0).toFixed(1)}% move
          </div>
          <p className={styles.cardDesc}>{METRIC_INFO.expectedMove.description}</p>
        </div>

        <div className={styles.card}>
          <h3>
            Put/Call Volume Skew {activeExpiry && `(${activeExpiry})`}
            <MetricTooltip metricKey="volumeSkew" />
          </h3>
          <div className={`${styles.largeValue} ${data.putCallSkew.volumeRatio > 1 ? styles.bearish : styles.bullish}`}>
            {data.putCallSkew.volumeRatio.toFixed(2)}×
          </div>
          <div className={styles.subtext}>
            {data.putCallSkew.totalPutVol.toLocaleString()} Puts / {data.putCallSkew.totalCallVol.toLocaleString()} Calls
          </div>
          {(data.putCallSkew.totalPutVol + data.putCallSkew.totalCallVol) > 1000 ? (
            <>
              {data.putCallSkew.volumeRatio > 1.2 && (
                <div className={`${styles.trendIndicator} ${styles.trendBearish}`}>
                  <span className={styles.trendArrow}>↑</span> Rising Hedging/Fear
                </div>
              )}
              {data.putCallSkew.volumeRatio < 0.8 && (
                <div className={`${styles.trendIndicator} ${styles.trendBullish}`}>
                  <span className={styles.trendArrow}>↓</span> Complacency
                </div>
              )}
            </>
          ) : (
            <div className={styles.trendIndicator} style={{ color: '#888' }}>
              Low Liquidity (No Signal)
            </div>
          )}
          <p className={styles.cardDesc}>{METRIC_INFO.volumeSkew.description}</p>
        </div>

        <div className={styles.card}>
          <h3>
            Put/Call OI Skew {activeExpiry && `(${activeExpiry})`}
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

      <div className={styles.grid}>
        <div className={styles.card}>
          <h3>
            Net GEX Regime
            <MetricTooltip metricKey="gex" />
          </h3>
          <div className={`${styles.largeValue} ${totalNetGex > 10000000 ? styles.gexPinning : totalNetGex < -10000000 ? styles.gexAmplified : ''}`}>
            {totalNetGex > 10000000 ? 'Pinning' : totalNetGex < -10000000 ? 'Amplified' : 'Neutral'}
          </div>
          <div className={styles.subtext}>
            Net GEX: ${(totalNetGex / 1000000).toFixed(1)}M
          </div>
          <p className={styles.cardDesc}>Dealers will buy dips (Pinning) or sell dips (Amplified)</p>
        </div>

        <div className={styles.card}>
          <h3>Peak GEX Strike</h3>
          <div className={styles.largeValue}>${maxGexStrike}</div>
          <div className={styles.subtext}>
            GEX Value: ${(maxGexValue / 1000000).toFixed(1)}M
          </div>
          <p className={styles.cardDesc}>The strike with the largest dealer gamma exposure, often acting as a strong magnet or wall.</p>
        </div>

        <div className={styles.card}>
          <h3>
            Gamma Flip Level
            <MetricTooltip metricKey="gammaFlip" />
          </h3>
          <div className={styles.largeValue}>${data.gammaFlipStrike.toFixed(2)}</div>
          <div className={styles.subtext}>
            Spot ${data.spotPrice.toFixed(2)}
          </div>
          <p className={styles.cardDesc}>{METRIC_INFO.gammaFlip.description}</p>
        </div>
      </div>

      <div className={styles.chartsGrid}>
        <div className={styles.chartCard}>
          <h3>
            Gamma Exposure (GEX) Profile {activeExpiry && `(${activeExpiry})`}
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
                  // Dim low-liquidity strikes relative to peak
                  const strikeOpacity = Math.max(0.3, Math.min(0.85, (Math.abs(d.callGex) + Math.abs(d.putGex)) / (Math.abs(maxGexValue) * 0.2)));

                  return (
                    <g key={d.strike}>
                      {callHeight > 0 && (
                        <rect x={x + 2} y={125 - callHeight} width="10" height={callHeight} fill="#00d4aa" opacity={strikeOpacity} rx="1" />
                      )}
                      {putHeight > 0 && (
                        <rect x={x + 2} y={125} width="10" height={putHeight} fill="#ff4d4d" opacity={strikeOpacity} rx="1" />
                      )}
                      {i % Math.ceil(data.gexProfile.length / 15) === 0 && (
                        <text x={x + 7} y="240" fill="#6b6b8a" fontSize="10" textAnchor="end" transform={`rotate(-45, ${x + 7}, 240)`}>
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
            {data.termStructure.map((ts, idx) => {
              const prevTs = idx > 0 ? data.termStructure[idx - 1] : null;
              let regime = 'Flat';
              if (prevTs) {
                if (prevTs.averageIV > ts.averageIV + 0.05) regime = 'Backwardation';
                else if (ts.averageIV > prevTs.averageIV + 0.05) regime = 'Contango';
              } else if (data.termStructure.length > 1) {
                const nextTs = data.termStructure[idx + 1];
                if (ts.averageIV > nextTs.averageIV + 0.05) regime = 'Backwardation';
                else if (nextTs.averageIV > ts.averageIV + 0.05) regime = 'Contango';
              }

              return (
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
                  {regime === 'Backwardation' && (
                    <span className={styles.eventRiskFlag}>Event Risk</span>
                  )}
                </div>
              );
            })}
          </div>
          {data.termStructure.length > 1 && (
            <div className={`${styles.regimeLabel} ${
              data.termStructure[0].averageIV > data.termStructure[1].averageIV 
                ? styles.regimeBackwardation 
                : styles.regimeContango
            }`}>
              {data.termStructure[0].averageIV > data.termStructure[1].averageIV ? 'Backwardation' : 'Contango'}
            </div>
          )}
          <p className={styles.cardDesc}>{METRIC_INFO.termStructure.description}</p>
        </div>
      </div>

      <div className={styles.fullWidthChartsGrid}>
        <div className={styles.chartCard}>
          <h3>Volume / Open Interest Heatmap {activeExpiry && `(${activeExpiry})`}</h3>
          <p className={styles.subtext}>Highlights strikes where today's volume significantly exceeds historical positioning</p>
          
          <div className={styles.heatmapLegend}>
            <div className={styles.heatmapLegendItem}>
              <div className={styles.heatmapLegendDot} style={{ background: 'var(--color-up)' }} /> Calls
            </div>
            <div className={styles.heatmapLegendItem}>
              <div className={styles.heatmapLegendDot} style={{ background: 'var(--color-down)' }} /> Puts
            </div>
            <div className={styles.heatmapLegendItem}>
              ⚡ Institutional Spike (&gt;3x)
            </div>
          </div>

          <div className={styles.heatmapContainer}>
            {data.volumeOIByStrike?.filter(d => d.totalVolOI > 0.5).slice(0, 15).map(d => (
              <div key={d.strike} className={styles.heatmapRow}>
                <div className={styles.heatmapStrike}>${d.strike}</div>
                <div className={styles.heatmapBarContainer}>
                  {d.callVolOI > 0 && (
                    <div 
                      className={styles.heatmapBarCall} 
                      style={{ 
                        width: `${Math.min(50, d.callVolOI * 10)}%`,
                        background: d.callVolOI > 3 ? 'var(--color-up)' : 'var(--color-up-dim)' 
                      }} 
                    />
                  )}
                  {d.putVolOI > 0 && (
                    <div 
                      className={styles.heatmapBarPut} 
                      style={{ 
                        width: `${Math.min(50, d.putVolOI * 10)}%`,
                        background: d.putVolOI > 3 ? 'var(--color-down)' : 'var(--color-down-dim)'
                      }} 
                    />
                  )}
                </div>
                <div className={`${styles.heatmapValue} ${
                  Math.max(d.callVolOI, d.putVolOI) > 3 ? styles.heatmapHot : 
                  Math.max(d.callVolOI, d.putVolOI) > 1.5 ? styles.heatmapWarm : styles.heatmapCool
                }`}>
                  {Math.max(d.callVolOI, d.putVolOI).toFixed(1)}x
                  {Math.max(d.callVolOI, d.putVolOI) > 3 && <span className={styles.heatmapSpike}>⚡</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.chartCard}>
          <h3>OI Change Day-over-Day</h3>
          <p className={styles.subtext}>Top positions opening and closing across all expirations</p>
          
          {(!data.oiChanges || data.oiChanges.length === 0) ? (
            <div className={styles.oiChangeEmpty}>
              Pending overnight snapshot. Check back tomorrow for Day-over-Day changes.
            </div>
          ) : (
            <div className={styles.oiChangeGrid}>
              <div className={styles.oiChangeColumn}>
                <div className={`${styles.oiChangeColumnTitle} ${styles.oiChangeOpening}`}>Opening (New Conviction)</div>
                {data.oiChanges.filter(d => d.oiChange > 0).slice(0, 5).map((d, i) => (
                  <div key={i} className={styles.oiChangeRow}>
                    <div className={styles.oiChangeStrike}>${d.strike}</div>
                    <div className={`${styles.oiChangeSide} ${d.side === 'call' ? styles.oiChangeSideCall : styles.oiChangeSidePut}`}>
                      {d.side.charAt(0)}
                    </div>
                    <div className={styles.tsLabel} style={{ width: 'auto' }}>{d.expiry}</div>
                    <div className={`${styles.oiChangeDelta} ${styles.oiChangeDeltaUp}`}>
                      +{d.oiChange.toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
              
              <div className={styles.oiChangeColumn}>
                <div className={`${styles.oiChangeColumnTitle} ${styles.oiChangeClosing}`}>Closing (Unwinds)</div>
                {data.oiChanges.filter(d => d.oiChange < 0).slice(0, 5).map((d, i) => (
                  <div key={i} className={styles.oiChangeRow}>
                    <div className={styles.oiChangeStrike}>${d.strike}</div>
                    <div className={`${styles.oiChangeSide} ${d.side === 'call' ? styles.oiChangeSideCall : styles.oiChangeSidePut}`}>
                      {d.side.charAt(0)}
                    </div>
                    <div className={styles.tsLabel} style={{ width: 'auto' }}>{d.expiry}</div>
                    <div className={`${styles.oiChangeDelta} ${styles.oiChangeDeltaDown}`}>
                      {d.oiChange.toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
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
