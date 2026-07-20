import React from 'react';
import { Outlet } from 'react-router-dom';
import { AlertsMenu } from './AlertsMenu';
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
        <div className={styles.logo}>
          <div className={styles.logoGlow}>
            <img src="/logo.png" alt="Hand of Midas Logo" className={styles.logoImg} />
          </div>
          <div className={styles.logoText}>
            <h1>Hand of Midas</h1>
            <span className={styles.tagline}>The Golden Touch</span>
          </div>
        </div>
        <div className={styles.userMenu}>
          <AlertsMenu />
          <span className={styles.liveBadge}>
            <span className={styles.liveDot} />
            Live
          </span>
          <button onClick={handleSignOut} className={styles.signOutBtn}>
            Sign Out
          </button>
        </div>
      </header>
      <main className={styles.mainContent}>
        <Outlet />
      </main>
    </div>
  );
};
