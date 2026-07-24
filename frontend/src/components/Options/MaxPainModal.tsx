import React, { useState, useEffect } from 'react';
import styles from './MaxPainModal.module.css';

interface VolumeOIByStrike {
  strike: number;
  callOI: number;
  putOI: number;
}

interface Props {
  symbol: string;
  maxPainStrike: number;
  optionsData: VolumeOIByStrike[];
  children: React.ReactNode;
}

export const MaxPainModal: React.FC<Props> = ({ symbol, maxPainStrike, optionsData, children }) => {
  const [isOpen, setIsOpen] = useState(false);

  // Close on Escape
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, []);

  return (
    <>
      <div onClick={() => setIsOpen(true)} style={{ cursor: 'pointer', height: '100%', width: '100%' }}>
        {children}
      </div>

      <div 
        className={`${styles.modalOverlay} ${isOpen ? styles.active : ''}`}
        onClick={() => setIsOpen(false)}
      >
        <div 
          className={styles.modalContent} 
          onClick={(e) => e.stopPropagation()}
        >
          <div className={styles.header}>
            <h2>Max Pain Analysis</h2>
            <button className={styles.closeBtn} onClick={() => setIsOpen(false)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          
          <div className={styles.body}>
            <div className={styles.explanation}>
              <strong>Max Pain is ${maxPainStrike.toFixed(2)}</strong>.<br/><br/>
              This is the strike price where the highest number of options contracts will expire worthless, minimizing the payout by option sellers and maximizing the "pain" (loss) for option buyers.
            </div>

            <div className={styles.dataList}>
              {(() => {
                if (!optionsData || optionsData.length === 0) return <div>No data available</div>;
                
                // Get unique strikes
                const strikes = optionsData.map(d => d.strike).sort((a, b) => a - b);
                
                // Find index of max pain strike
                let centerIdx = strikes.indexOf(maxPainStrike);
                if (centerIdx === -1) {
                   // Fallback to closest if not exact match
                   centerIdx = strikes.reduce((closest, curr, idx) => 
                     Math.abs(curr - maxPainStrike) < Math.abs(strikes[closest] - maxPainStrike) ? idx : closest
                   , 0);
                }

                // Get 3 strikes below and 3 strikes above
                const startIdx = Math.max(0, centerIdx - 3);
                const endIdx = Math.min(strikes.length - 1, centerIdx + 3);
                const displayStrikes = strikes.slice(startIdx, endIdx + 1);

                return displayStrikes.map(s => {
                  let totalPain = 0;
                  optionsData.forEach(opt => {
                    // Calls expire ITM if Strike Price (s) > Call Strike
                    if (s > opt.strike) {
                      totalPain += (s - opt.strike) * (opt.callOI || 0) * 100;
                    }
                    // Puts expire ITM if Strike Price (s) < Put Strike
                    if (s < opt.strike) {
                      totalPain += (opt.strike - s) * (opt.putOI || 0) * 100;
                    }
                  });

                  const isMaxPain = s === maxPainStrike;

                  return (
                    <div key={s} className={`${styles.dataRow} ${isMaxPain ? styles.maxPain : ''}`}>
                      <span className={styles.strike}>
                        Strike ${s.toFixed(2)}
                        {isMaxPain && <span className={styles.badge} style={{marginLeft: '8px'}}>Max Pain</span>}
                      </span>
                      <span className={styles.value}>
                        ${totalPain.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
