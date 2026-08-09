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
          <Link to="/screener" className={`${styles.screenerBtn} ${styles.screenerBtnCool}`} title="Market Screener">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.icon}>
              <path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/>
              <path d="M4 6h.01"/>
              <path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/>
              <path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/>
              <path d="M12 18h.01"/>
              <path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/>
              <circle cx="12" cy="12" r="2"/>
              <path d="m13.41 10.59 5.66-5.66"/>
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
