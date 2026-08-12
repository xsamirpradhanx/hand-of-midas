import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { LoginPage } from './components/Auth/LoginPage';
import { Dashboard } from './pages/Dashboard';
import { AppLayout } from './components/Layout/AppLayout';
import type { ReactNode } from 'react';

import ScreenerDashboard from './components/Screener/ScreenerDashboard';
import DiagonalScreener from './components/Screener/DiagonalScreener';
import SentimentDashboard from './components/Sentiment/SentimentDashboard';

/**
 * Auth guard — redirects unauthenticated users to /login.
 */
function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          color: 'var(--text-tertiary)',
          fontSize: '0.875rem',
        }}
      >
        Loading…
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

/**
 * Root application component.
 *
 * Wraps all routes with `AuthProvider` and defines the route table:
 * - `/login` — public auth page
 * - `/` — protected dashboard
 */
export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="screener" element={<ScreenerDashboard />} />
          <Route path="screener/diagonal" element={<DiagonalScreener />} />
          <Route path="sentiment" element={<SentimentDashboard />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
