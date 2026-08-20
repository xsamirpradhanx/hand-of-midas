import React, { useEffect, useState } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { AlertsMenu } from './AlertsMenu';
import { ProviderSelector } from './ProviderSelector';
import { TickerSearchBar } from './TickerSearchBar';
import { ToastManager } from './ToastManager';
import { MarketOverview } from '../Market/MarketOverview';
import { useIsMobile } from '../../hooks/useMediaQuery';
import styles from './AppLayout.module.css';

const NAV_ITEMS = [
  {
    to: '/',
    label: 'Chart',
    title: 'Price Chart',
    path: (
      <>
        <path d="M3 3v18h18" />
        <path d="m19 9-5 5-4-4-3 3" />
      </>
    ),
  },
  {
    to: '/screener',
    label: 'Screener',
    title: 'Market Screener',
    path: (
      <>
        <path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7z" />
        <path d="M5 21h14" />
      </>
    ),
  },
  {
    to: '/sentiment',
    label: 'Sentiment',
    title: 'Sentiment Dashboard',
    path: (
      <>
        <path d="M12 21a9 9 0 1 0-9-9c0 1.488.406 2.89 1.125 4.094L3 21l4.906-1.125A8.956 8.956 0 0 0 12 21Z" />
        <path d="M9 13h.01" />
        <path d="M15 13h.01" />
        <path d="M12 17c-1.5 0-2.5-.5-3-1.5" />
      </>
    ),
  },
];

const NavIcon: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={styles.icon}
  >
    {children}
  </svg>
);

export const AppLayout: React.FC = () => {
  const location = useLocation();
  const isMobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);
  const hideProviderSelector =
    location.pathname.startsWith('/screener') || location.pathname.startsWith('/sentiment');

  // Route changes should dismiss the drawer, otherwise tapping a nav item leaves
  // the menu covering the page it just navigated to.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  // Leaving mobile width with the drawer open would strand an invisible overlay
  // over the desktop layout, swallowing clicks.
  useEffect(() => {
    if (!isMobile) setMenuOpen(false);
  }, [isMobile]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const handleSignOut = () => {
    localStorage.removeItem('jwt_token');
    window.location.href = '/login';
  };

  return (
    <div className={styles.layout}>
      <header className={styles.topbar}>
        <Link to="/" className={styles.logo} style={{ textDecoration: 'none' }}>
          <div className={styles.logoGlow}>
            <img src="/logo.png" alt="Hand of Midas" className={styles.logoImg} />
          </div>
          {/* Wordmark is hidden under 768px — at that width "Hand of Midas" wrapped to
              two lines and forced the topbar taller than its own height variable. */}
          <div className={styles.logoText}>
            <h1>Hand of Midas</h1>
            <span className={styles.tagline}>The Golden Touch</span>
          </div>
        </Link>

        <div className={styles.centerSection}>
          <TickerSearchBar />
        </div>

        <div className={styles.userMenu}>
          {!hideProviderSelector && (
            <div className={styles.desktopOnly}>
              <ProviderSelector />
            </div>
          )}
          {NAV_ITEMS.map(item => (
            <Link
              key={item.to}
              to={item.to}
              className={`${styles.screenerBtn} ${styles.screenerBtnCool} ${styles.desktopOnly} ${
                location.pathname === item.to ? styles.navActive : ''
              }`}
              title={item.title}
            >
              <NavIcon>{item.path}</NavIcon>
            </Link>
          ))}
          <AlertsMenu />
          <div className={`${styles.liveBadge} ${styles.desktopOnly}`}>
            <span className={styles.liveDotWrapper}>
              <span className={styles.liveDotPing} />
              <span className={styles.liveDot} />
            </span>
            <span className={styles.liveText}>LIVE</span>
          </div>
          <button onClick={handleSignOut} className={`${styles.signOutBtn} ${styles.desktopOnly}`}>
            Sign Out
          </button>

          <button
            type="button"
            className={styles.hamburger}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav-drawer"
            onClick={() => setMenuOpen(o => !o)}
          >
            <span className={`${styles.burgerBar} ${menuOpen ? styles.burgerBarTop : ''}`} />
            <span className={`${styles.burgerBar} ${menuOpen ? styles.burgerBarMid : ''}`} />
            <span className={`${styles.burgerBar} ${menuOpen ? styles.burgerBarBot : ''}`} />
          </button>
        </div>
      </header>

      {menuOpen && <div className={styles.backdrop} onClick={() => setMenuOpen(false)} />}
      <nav
        id="mobile-nav-drawer"
        className={`${styles.mobileDrawer} ${menuOpen ? styles.mobileDrawerOpen : ''}`}
        aria-hidden={!menuOpen}
      >
        <div className={styles.drawerSection}>
          {NAV_ITEMS.map(item => (
            <Link
              key={item.to}
              to={item.to}
              className={`${styles.drawerLink} ${location.pathname === item.to ? styles.drawerLinkActive : ''}`}
            >
              <NavIcon>{item.path}</NavIcon>
              <span>{item.label}</span>
            </Link>
          ))}
        </div>

        {!hideProviderSelector && (
          <div className={styles.drawerSection}>
            <span className={styles.drawerLabel}>Data Provider</span>
            <ProviderSelector />
          </div>
        )}

        <div className={styles.drawerFooter}>
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
      </nav>

      <MarketOverview />
      <main className={styles.mainContent}>
        <Outlet />
      </main>
      <ToastManager />
    </div>
  );
};
