import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import styles from './AlertsMenu.module.css';

interface Alert {
  pk: string;
  sk: string;
  symbol: string;
  message: string;
  timestamp: string;
  severity: 'high' | 'medium';
}

export const AlertsMenu: React.FC = () => {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    const fetchAlerts = () => {
      api.getAlerts()
        .then(res => {
          setAlerts(res);
          // For simplicity, just treating newly fetched alerts as unread if we aren't open
          if (!open) setUnread(res.length > 0 ? res.length : 0);
        })
        .catch(console.error);
    };

    fetchAlerts();
    const interval = setInterval(fetchAlerts, 60000);
    return () => clearInterval(interval);
  }, [open]);

  const handleOpen = () => {
    setOpen(!open);
    if (!open) setUnread(0);
  };

  return (
    <div className={styles.container}>
      <button className={styles.bellBtn} onClick={handleOpen}>
        🔔
        {unread > 0 && <span className={styles.badge}>{unread}</span>}
      </button>

      {open && (
        <div className={styles.dropdown}>
          <div className={styles.header}>
            <h4>Market Alerts</h4>
          </div>
          <div className={styles.alertList}>
            {alerts.length === 0 ? (
              <div className={styles.empty}>No recent alerts</div>
            ) : (
              alerts.map(a => (
                <div key={a.sk} className={`${styles.alertItem} ${a.severity === 'high' ? styles.high : styles.medium}`}>
                  <div className={styles.alertHeader}>
                    <span className={styles.symbol}>{a.symbol}</span>
                    <span className={styles.time}>{new Date(a.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <p className={styles.message}>{a.message}</p>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
