import React from 'react';
import { Outlet } from 'react-router-dom';
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
          <h1>Hand of Midas</h1>
        </div>
        <div className={styles.userMenu}>
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
