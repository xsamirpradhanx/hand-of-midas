import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../../lib/api';
import { blackScholes, probabilityOfTouch, expectedMove } from '../../lib/greeks';
import type { OptionsChainResponse } from '../../types';
import styles from './OptionsOutcome.module.css';

interface Props {
  symbol: string;
  activeExpiry: string | null;
}

export const OptionsOutcome: React.FC<Props> = ({ symbol, activeExpiry }) => {
  const [data, setData] = useState<OptionsChainResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [spot, setSpot] = useState(0);
  
  // Scenarios
  const [priceAdjustPct, setPriceAdjustPct] = useState(0);
  const [ivAdjustPct, setIvAdjustPct] = useState(0);
  const [selectedStrike, setSelectedStrike] = useState<number | null>(null);
  const [contractType, setContractType] = useState<'call' | 'put'>('call');

  useEffect(() => {
    if (!symbol || !activeExpiry) return;
    let mounted = true;
    
    setLoading(true);
    api.getOptionsChain(symbol, activeExpiry).then(res => {
      if (!mounted) return;
      setData(res);
      setSpot(res.underlyingPrice || 0);
      
      const chain = res.chain[activeExpiry];
      if (chain && chain.length > 0) {
        // Find nearest ATM strike
        const strikes = Array.from(new Set(chain.map(c => c.strike))).sort((a,b) => a - b);
        const atm = strikes.reduce((prev, curr) => 
          Math.abs(curr - res.underlyingPrice) < Math.abs(prev - res.underlyingPrice) ? curr : prev
        );
        setSelectedStrike(atm);
      }
      setLoading(false);
    }).catch(() => setLoading(false));

    return () => { mounted = false; };
  }, [symbol, activeExpiry]);

  const contract = useMemo(() => {
    if (!data || !activeExpiry || selectedStrike === null) return null;
    const chain = data.chain[activeExpiry] || [];
    return chain.find(c => c.strike === selectedStrike && c.type === contractType) || null;
  }, [data, activeExpiry, selectedStrike, contractType]);

  const scenario = useMemo(() => {
    if (!contract || !data || spot <= 0) return null;
    
    const newSpot = spot * (1 + priceAdjustPct / 100);
    const newIv = Math.max(0.01, contract.impliedVolatility * (1 + ivAdjustPct / 100));
    const dteYears = Math.max(0.0027, contract.dte / 365);
    const riskFreeRate = 0.05;

    const bs = blackScholes(newSpot, contract.strike, dteYears, riskFreeRate, newIv, contractType);
    const pItm = probabilityOfTouch(newSpot, contract.strike, dteYears, riskFreeRate, newIv, contractType);
    const em = expectedMove(newSpot, newIv, dteYears);

    return {
      spot: newSpot,
      iv: newIv,
      greeks: bs,
      probItm: pItm,
      expectedMove: em
    };
  }, [contract, spot, priceAdjustPct, ivAdjustPct, contractType]);

  if (loading) return <div className={styles.emptyState}>Loading predictor...</div>;
  if (!data || !activeExpiry) return <div className={styles.emptyState}>No options data available</div>;

  const strikes = Array.from(new Set((data.chain[activeExpiry] || []).map(c => c.strike))).sort((a,b) => a - b);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2>Outcome Predictor</h2>
        <p className={styles.subtext}>Interactive Greek scenarios and mathematical outcome models</p>
      </div>

      <div className={styles.selector}>
        <label>
          Strike:
          <select 
            className={styles.select} 
            value={selectedStrike || ''} 
            onChange={e => setSelectedStrike(Number(e.target.value))}
            style={{ marginLeft: '0.5rem' }}
          >
            {strikes.map(s => <option key={s} value={s}>${s.toFixed(2)}</option>)}
          </select>
        </label>
        <label>
          Type:
          <select 
            className={styles.select} 
            value={contractType} 
            onChange={e => setContractType(e.target.value as 'call' | 'put')}
            style={{ marginLeft: '0.5rem' }}
          >
            <option value="call">Call</option>
            <option value="put">Put</option>
          </select>
        </label>
        <span style={{ marginLeft: 'auto', color: '#b0b0c0' }}>
          Base Spot: <strong>${spot.toFixed(2)}</strong>
        </span>
      </div>

      {!contract ? (
        <div className={styles.emptyState}>Contract not found on chain</div>
      ) : (
        <div className={styles.grid}>
          {/* Greeks Card */}
          <div className={styles.card}>
            <h3>Live Greeks (Black-Scholes)</h3>
            <div className={styles.greeksGrid}>
              <div className={styles.greekItem}>
                <span className={styles.greekLabel}>Theo Price</span>
                <span className={styles.neutral}>${scenario?.greeks.price.toFixed(2)}</span>
              </div>
              <div className={styles.greekItem}>
                <span className={styles.greekLabel}>Market Bid/Ask</span>
                <span className={styles.neutral}>${contract.bid} / ${contract.ask}</span>
              </div>
              <div className={styles.greekItem}>
                <span className={styles.greekLabel}>Δ Delta</span>
                <span className={scenario?.greeks.delta && scenario.greeks.delta > 0 ? styles.positive : styles.negative}>
                  {scenario?.greeks.delta.toFixed(4)}
                </span>
              </div>
              <div className={styles.greekItem}>
                <span className={styles.greekLabel}>Γ Gamma</span>
                <span className={styles.positive}>{scenario?.greeks.gamma.toFixed(4)}</span>
              </div>
              <div className={styles.greekItem}>
                <span className={styles.greekLabel}>Θ Theta</span>
                <span className={styles.negative}>{scenario?.greeks.theta.toFixed(4)}</span>
              </div>
              <div className={styles.greekItem}>
                <span className={styles.greekLabel}>V Vega</span>
                <span className={styles.positive}>{scenario?.greeks.vega.toFixed(4)}</span>
              </div>
              <div className={styles.greekItem}>
                <span className={styles.greekLabel}>ρ Rho</span>
                <span className={scenario?.greeks.rho && scenario.greeks.rho > 0 ? styles.positive : styles.negative}>
                  {scenario?.greeks.rho.toFixed(4)}
                </span>
              </div>
              <div className={styles.greekItem}>
                <span className={styles.greekLabel}>Implied Vol</span>
                <span className={styles.neutral}>{(scenario!.iv * 100).toFixed(1)}%</span>
              </div>
              <div className={styles.greekItem}>
                <span className={styles.greekLabel}>Vanna</span>
                <span className={scenario?.greeks.vanna && scenario.greeks.vanna > 0 ? styles.positive : styles.negative}>
                  {scenario?.greeks.vanna.toFixed(4)}
                </span>
              </div>
              <div className={styles.greekItem}>
                <span className={styles.greekLabel}>Charm</span>
                <span className={scenario?.greeks.charm && scenario.greeks.charm > 0 ? styles.positive : styles.negative}>
                  {scenario?.greeks.charm.toFixed(4)}
                </span>
              </div>
              <div className={styles.greekItem}>
                <span className={styles.greekLabel}>Vomma</span>
                <span className={styles.positive}>{scenario?.greeks.vomma.toFixed(4)}</span>
              </div>
              <div className={styles.greekItem}>
                <span className={styles.greekLabel}>Speed</span>
                <span className={scenario?.greeks.speed && scenario.greeks.speed > 0 ? styles.positive : styles.negative}>
                  {scenario?.greeks.speed.toFixed(4)}
                </span>
              </div>
              <div className={styles.greekItem}>
                <span className={styles.greekLabel}>Color</span>
                <span className={scenario?.greeks.color && scenario.greeks.color > 0 ? styles.positive : styles.negative}>
                  {scenario?.greeks.color.toFixed(4)}
                </span>
              </div>
            </div>
          </div>

          {/* Scenario Analyzer */}
          <div className={styles.card}>
            <h3>Scenario Analyzer</h3>
            <div className={styles.scenarioControl}>
              <div className={styles.scenarioHeader}>
                <span>Spot Shift: {(priceAdjustPct > 0 ? '+' : '') + priceAdjustPct.toFixed(1)}%</span>
                <span className={styles.positive}>${scenario?.spot.toFixed(2)}</span>
              </div>
              <input 
                type="range" 
                min="-20" max="20" step="0.5" 
                value={priceAdjustPct} 
                onChange={e => setPriceAdjustPct(Number(e.target.value))}
                className={styles.slider}
              />
            </div>
            
            <div className={styles.scenarioControl}>
              <div className={styles.scenarioHeader}>
                <span>IV Shift: {(ivAdjustPct > 0 ? '+' : '') + ivAdjustPct.toFixed(1)}%</span>
              </div>
              <input 
                type="range" 
                min="-50" max="100" step="1" 
                value={ivAdjustPct} 
                onChange={e => setIvAdjustPct(Number(e.target.value))}
                className={styles.slider}
              />
            </div>

            <div className={styles.probItem} style={{ marginTop: '2rem' }}>
              <div className={styles.probLabel}>
                <span>Probability of Touch (PoT)</span>
                <span>{(scenario!.probItm * 100).toFixed(1)}%</span>
              </div>
              <div className={styles.probBar}>
                <div className={styles.probFill} style={{ width: `${scenario!.probItm * 100}%` }} />
              </div>
            </div>
            
            <div className={styles.probItem}>
              <div className={styles.probLabel}>
                <span>1-σ Expected Move</span>
                <span>±${scenario?.expectedMove.toFixed(2)}</span>
              </div>
              <div className={styles.subtext}>
                Implies a range of ${(scenario!.spot - scenario!.expectedMove).toFixed(2)} to ${(scenario!.spot + scenario!.expectedMove).toFixed(2)}
              </div>
            </div>
          </div>

          {/* Narrative / Reasoning */}
          <div className={styles.card} style={{ gridColumn: '1 / -1' }}>
            <h3>Mathematical Reasoning</h3>
            <p className={styles.narrativeText}>
              Based on the Black-Scholes-Merton model, this {contract.strike} {contractType} option is currently valued at <strong>${scenario?.greeks.price.toFixed(2)}</strong> under the simulated scenario of a <strong>{priceAdjustPct > 0 ? '+' : ''}{priceAdjustPct}%</strong> move in the underlying asset and a <strong>{ivAdjustPct > 0 ? '+' : ''}{ivAdjustPct}%</strong> shift in implied volatility.
              <br/><br/>
              The contract carries a Delta of <strong>{scenario?.greeks.delta.toFixed(2)}</strong>, meaning its price will move approximately ${Math.abs(scenario?.greeks.delta || 0).toFixed(2)} for the next $1.00 move in {symbol}. 
              With a Theta of <strong>{scenario?.greeks.theta.toFixed(2)}</strong>, the option loses about ${Math.abs(scenario?.greeks.theta || 0).toFixed(2)} of extrinsic value per day due to time decay.
              <br/><br/>
              Institutional indicators: A Vanna of <strong>{scenario?.greeks.vanna.toFixed(4)}</strong> implies Delta will shift by this amount per 1% change in IV (highlighting vol-crush risk). 
              A Charm of <strong>{scenario?.greeks.charm.toFixed(4)}</strong> dictates how much Delta will passively decay per day towards 0 or 1, driving MOC dealer flows.
              <br/><br/>
              The statistical probability of the underlying price touching the strike price before expiration is <strong>{(scenario!.probItm * 100).toFixed(1)}%</strong>, while the 1-standard-deviation expected move predicts a price corridor of ±${scenario?.expectedMove.toFixed(2)}.
            </p>

            <details className={styles.refs}>
              <summary>Academic References & Formulas</summary>
              <ul>
                <li><strong>Black-Scholes-Merton (1973):</strong> C = S*N(d1) - K*e^(-rT)*N(d2). Used for theoretical pricing and Greeks derivation.</li>
                <li><strong>Probability of Touch:</strong> First-passage time reflection principle approximation using standard Brownian motion drift.</li>
                <li><strong>Vanna & Charm:</strong> Garman (1985). Measures d(Delta)/d(Vol) and d(Delta)/d(Time) to predict dealer hedging flows during volatility crushes and over the weekend.</li>
                <li><strong>Vomma, Speed, & Color:</strong> Haug (2007). Higher order derivatives measuring the convexity of Vega and the decay rate of Gamma.</li>
              </ul>
            </details>
          </div>
        </div>
      )}
    </div>
  );
};
