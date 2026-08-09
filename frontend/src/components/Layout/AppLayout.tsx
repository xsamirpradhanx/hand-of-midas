import React from 'react';
import { Outlet, Link } from 'react-router-dom';
import { AlertsMenu } from './AlertsMenu';
import { ProviderSelector } from './ProviderSelector';
import { ToastManager } from './ToastManager';
import styles from './AppLayout.module.css';

export const AppLayout: React.FC = () => {
  const handleSignOut = () => {
    // We'll wire this to AuthContext later
    localStorage.removeItem('jwt_token');
    window.location.href = '/login';
  };

  return (
    <div className={styles.layout}>
      <header className={styles.topbar}>
        <Link to="/" className={styles.logo} style={{ textDecoration: 'none' }}>
          <div className={styles.logoGlow}>
            <img src="/logo.png" alt="Hand of Midas Logo" className={styles.logoImg} />
          </div>
          <div className={styles.logoText}>
            <h1>Hand of Midas</h1>
            <span className={styles.tagline}>The Golden Touch</span>
          </div>
        </Link>

        <div className={styles.userMenu}>
          <ProviderSelector />
          <Link to="/screener" className={styles.screenerBtn} title="Quantitative Screener">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.icon}>
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </Link>
          <Link to="/screener/diagonal" className={styles.screenerBtn} title="Diagonal Spread Scanner" style={{ color: '#c4b5fd' }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.icon}>
              <path d="M3 3l7.5 7.5M16.5 16.5L21 21M21 3l-9 9M12 12l9 9" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </Link>
          <AlertsMenu />
          <div className={styles.liveBadge}>
            <span className={styles.liveDotWrapper}>
              <span className={styles.liveDotPing} />
              <span className={styles.liveDot} />
            </span>
            <span className={styles.liveText}>LIVE</span>
          </div>
          <button onClick={handleSignOut} className={styles.signOutBtn}>
            Sign Out
          </button>
        </div>
      </header>
      <main className={styles.mainContent}>
        <Outlet />
      </main>
      <ToastManager />
    </div>
  );
};
