import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { SectorHeatmapResponse } from '../../types';
type SectorData = SectorHeatmapResponse['sectors'][0];
import styles from './SectorHeatmap.module.css';

export const SectorHeatmap: React.FC = () => {
  const [sectors, setSectors] = useState<SectorData[]>([]);
  const [loading, setLoading] = useState(true);
  const wrapperRef = React.useRef<HTMLDivElement>(null);

  const setScrollDir = (dir: 'normal' | 'reverse') => {
    if (wrapperRef.current) {
      const animations = wrapperRef.current.getAnimations();
      if (animations.length > 0) {
        animations[0].playbackRate = dir === 'normal' ? 1 : -1;
      }
    }
  };

  useEffect(() => {
    let mounted = true;
    const fetchSectors = async () => {
      try {
        const res = await api.getSectors();
        if (mounted) {
          setSectors(res.sectors || []);
        }
      } catch (err) {
        console.error('Failed to fetch sectors', err);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    fetchSectors();
    const interval = setInterval(fetchSectors, 15000); // refresh every 15s

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (sectors.length > 0) {
      requestAnimationFrame(() => {
        if (wrapperRef.current) {
          const animations = wrapperRef.current.getAnimations();
          if (animations.length > 0) {
            // Only set if we haven't set it yet
            if ((animations[0].currentTime as number) < 40000000) {
              animations[0].currentTime = 45000000;
            }
          }
        }
      });
    }
  }, [sectors]);

  if (loading && sectors.length === 0) {
    return <div className={styles.container}><div className={styles.loading}>Loading Sector Heatmap...</div></div>;
  }

  if (sectors.length === 0) {
    return <div className={styles.container}>No sector data available.</div>;
  }

  // Calculate intensity based on max absolute change
  const maxChange = Math.max(...sectors.map(s => Math.abs(s.changePercent)), 1);

  const getHeatmapColor = (change: number) => {
    const intensity = Math.min(Math.abs(change) / maxChange, 1);
    if (change > 0) return `rgba(0, 230, 118, ${0.1 + intensity * 0.9})`;
    if (change < 0) return `rgba(255, 23, 68, ${0.1 + intensity * 0.9})`;
    return 'rgba(255, 255, 255, 0.1)';
  };

  const getTextColor = (change: number) => {
    if (change > 0) return '#00e676';
    if (change < 0) return '#ff1744';
    return '#ffffff';
  };

  const formatPercent = (val: number) => `${val > 0 ? '+' : ''}${val.toFixed(2)}%`;

  const renderTiles = (suffix: string) => (
    <div className={styles.scrollGroup}>
      {sectors.map((sector) => (
        <a
          href={`https://finance.yahoo.com/quote/${sector.symbol}`}
          target="_blank"
          rel="noopener noreferrer"
          key={`${sector.symbol}-${suffix}`}
          className={styles.tile}
          style={{ backgroundColor: getHeatmapColor(sector.changePercent) }}
        >
          <div className={styles.symbol}>{sector.symbol}</div>
          <div className={styles.name}>{sector.name}</div>
          <div className={styles.change} style={{ color: getTextColor(sector.changePercent) }}>
            {formatPercent(sector.changePercent)}
          </div>
        </a>
      ))}
    </div>
  );

  return (
    <div className={styles.container}>
      <div className={styles.scrollContainer}>
        <div className={styles.leftZone} onClick={() => setScrollDir('normal')}>&#10094;</div>
        <div className={styles.rightZone} onClick={() => setScrollDir('reverse')}>&#10095;</div>
        <div className={styles.scrollWrapper} ref={wrapperRef}>
          {renderTiles('1')}
          {renderTiles('2')}
          {renderTiles('3')}
          {renderTiles('4')}
        </div>
      </div>
    </div>
  );
};
