import React from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { AlertsMenu } from './AlertsMenu';
import { ProviderSelector } from './ProviderSelector';
import { TickerSearchBar } from './TickerSearchBar';
import { ToastManager } from './ToastManager';
import styles from './AppLayout.module.css';

export const AppLayout: React.FC = () => {
  const location = useLocation();
  const isScreenerPage = location.pathname.startsWith('/screener');

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

        <div className={styles.centerSection}>
          <TickerSearchBar />
        </div>

        <div className={styles.userMenu}>
          {!isScreenerPage && <ProviderSelector />}
          <Link to="/screener" className={`${styles.screenerBtn} ${styles.screenerBtnCool}`} title="Market Screener">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.icon}>
              <path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7z" />
              <path d="M5 21h14" />
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
