import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { SectorHeatmapResponse, SectorData } from '../../types';
import styles from './SectorHeatmap.module.css';

export const SectorHeatmap: React.FC = () => {
  const [sectors, setSectors] = useState<SectorData[]>([]);
  const [loading, setLoading] = useState(true);

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

  return (
    <div className={styles.container}>
      <h3 className={styles.header}>Sector Heatmap</h3>
      <div className={styles.grid}>
        {sectors.map((sector) => (
          <div
            key={sector.symbol}
            className={styles.tile}
            style={{ backgroundColor: getHeatmapColor(sector.changePercent) }}
          >
            <div className={styles.symbol}>{sector.symbol}</div>
            <div className={styles.name}>{sector.name}</div>
            <div className={styles.change} style={{ color: getTextColor(sector.changePercent) }}>
              {formatPercent(sector.changePercent)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
