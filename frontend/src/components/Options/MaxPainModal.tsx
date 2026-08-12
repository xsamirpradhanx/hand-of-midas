import React, { useState, useEffect, useRef } from 'react';
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

export const MaxPainModal: React.FC<Props> = ({ symbol: _symbol, maxPainStrike, optionsData, children }) => {
  const [isOpen, setIsOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const maxPainRef = useRef<HTMLDivElement>(null);

  const scrollInterval = useRef<NodeJS.Timeout | null>(null);

  // Scroll to Max Pain when opened
  useEffect(() => {
    if (isOpen && maxPainRef.current) {
      setTimeout(() => {
        maxPainRef.current?.scrollIntoView({ behavior: 'auto', block: 'center' });
      }, 50);
    }
  }, [isOpen]);

  const stopScroll = () => {
    if (scrollInterval.current) {
      clearInterval(scrollInterval.current);
      scrollInterval.current = null;
    }
  };

  useEffect(() => {
    return () => stopScroll();
  }, []);

  const startScrollUp = () => {
    if (listRef.current) {
      listRef.current.scrollBy({ top: -45, behavior: 'smooth' });
    }
    stopScroll();
    scrollInterval.current = setInterval(() => {
      if (listRef.current) {
        listRef.current.scrollBy({ top: -45, behavior: 'smooth' });
      }
    }, 150);
  };

  const startScrollDown = () => {
    if (listRef.current) {
      listRef.current.scrollBy({ top: 45, behavior: 'smooth' });
    }
    stopScroll();
    scrollInterval.current = setInterval(() => {
      if (listRef.current) {
        listRef.current.scrollBy({ top: 45, behavior: 'smooth' });
      }
    }, 150);
  };

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

            <div className={styles.scrollContainer}>
              <button 
                className={styles.scrollBtn} 
                onMouseDown={startScrollUp}
                onMouseUp={stopScroll}
                onMouseLeave={stopScroll}
                onTouchStart={startScrollUp}
                onTouchEnd={stopScroll}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="18 15 12 9 6 15"></polyline>
                </svg>
              </button>
              
              <div className={styles.dataList} ref={listRef}>
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

                // Show all calculated strike prices
                const displayStrikes = strikes;

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
                    <div 
                      key={s} 
                      className={`${styles.dataRow} ${isMaxPain ? styles.maxPain : ''}`}
                      ref={isMaxPain ? maxPainRef : null}
                    >
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

              <button 
                className={styles.scrollBtn} 
                onMouseDown={startScrollDown}
                onMouseUp={stopScroll}
                onMouseLeave={stopScroll}
                onTouchStart={startScrollDown}
                onTouchEnd={stopScroll}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
