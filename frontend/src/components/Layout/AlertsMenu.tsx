import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import styles from './AlertsMenu.module.css';

interface NewsItem {
  uuid: string;
  title: string;
  publisher: string;
  link: string;
  providerPublishTime: string | number | Date;
  relatedSymbol: string;
}

export const AlertsMenu: React.FC = () => {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [open, setOpen] = useState(false);
  const [readIds, setReadIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('midas_read_news');
      return new Set(stored ? JSON.parse(stored) : []);
    } catch {
      return new Set();
    }
  });
  const menuRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  useEffect(() => {
    const fetchNews = () => {
      api.getNews()
        .then(res => setNews(res))
        .catch(console.error);
    };

    fetchNews();
    const interval = setInterval(fetchNews, 60000);
    return () => clearInterval(interval);
  }, []);

  const handleOpen = () => {
    setOpen(!open);
  };

  const handleNewsClick = (item: NewsItem) => {
    const newReadIds = new Set(readIds);
    newReadIds.add(item.uuid);
    setReadIds(newReadIds);
    localStorage.setItem('midas_read_news', JSON.stringify(Array.from(newReadIds)));
    window.open(item.link, '_blank');
  };

  const unreadCount = news.filter(n => !readIds.has(n.uuid)).length;

  return (
    <div className={styles.container} ref={menuRef}>
      <button className={styles.bellBtn} onClick={handleOpen} title="Market News">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.icon}>
          <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/>
          <path d="M18 14h-8"/>
          <path d="M15 18h-5"/>
          <path d="M10 6h8v4h-8V6Z"/>
        </svg>
        {unreadCount > 0 && <span className={styles.badge}>{unreadCount}</span>}
      </button>

      {open && (
        <div className={styles.dropdown}>
          <div className={styles.header}>
            <h4>Market News</h4>
            <span className={styles.newsCount}>{unreadCount} unread</span>
          </div>
          <div className={styles.alertList}>
            {news.length === 0 ? (
              <div className={styles.empty}>No recent news</div>
            ) : (
              news.map(n => {
                const isRead = readIds.has(n.uuid);
                return (
                  <div 
                    key={n.uuid} 
                    className={`${styles.alertItem} ${isRead ? styles.readNews : styles.unreadNews}`}
                    onClick={() => handleNewsClick(n)}
                  >
                    <div className={styles.alertHeader}>
                      <span className={styles.symbol}>{n.relatedSymbol}</span>
                      <span className={styles.time}>{new Date(n.providerPublishTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <p className={styles.message}>{n.title}</p>
                    <span className={styles.publisher}>{n.publisher}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
