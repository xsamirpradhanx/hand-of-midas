import React, { useEffect, useState } from 'react';
import styles from './ToastManager.module.css';

interface ToastMessage {
  id: number;
  requested: string;
  actual: string;
}

export const ToastManager: React.FC = () => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => {
    const handleFallback = (e: Event) => {
      const customEvent = e as CustomEvent;
      const { requested, actual } = customEvent.detail;
      
      const newToast: ToastMessage = {
        id: Date.now(),
        requested: requested.charAt(0).toUpperCase() + requested.slice(1),
        actual: actual.charAt(0).toUpperCase() + actual.slice(1),
      };

      setToasts(prev => {
        // Prevent duplicate toasts if multiple API calls fall back at once
        if (prev.some(t => t.requested === newToast.requested && t.actual === newToast.actual)) {
          return prev;
        }
        return [...prev, newToast];
      });

      // Remove after 5 seconds
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== newToast.id));
      }, 5000);
    };

    window.addEventListener('DATA_PROVIDER_FALLBACK', handleFallback);
    return () => window.removeEventListener('DATA_PROVIDER_FALLBACK', handleFallback);
  }, []);

  return (
    <div className={styles.toastContainer}>
      {toasts.map(toast => (
        <div key={toast.id} className={styles.toast}>
          <span className={styles.icon}>⚠️</span>
          <div className={styles.content}>
            <strong>{toast.requested} unavailable.</strong>
            <span>Sourced from {toast.actual}</span>
          </div>
        </div>
      ))}
    </div>
  );
};
