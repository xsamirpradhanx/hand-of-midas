import { useEffect, useRef, useState } from 'react';

export type Provider = 'polygon' | 'finnhub' | 'yahoo';

export interface LiveTick {
  price: number;
  volume?: number;
  timestamp: number;
}

export function useLivePricing(symbol: string | null, provider: Provider = 'finnhub') {
  const [latestTick, setLatestTick] = useState<LiveTick | null>(null);
  const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!symbol) return;

    setStatus('connecting');
    setLatestTick(null);

    let ws: WebSocket;

    try {
      if (provider === 'finnhub') {
        const token = localStorage.getItem('FINNHUB_API_KEY') || import.meta.env.VITE_FINNHUB_API_KEY;
        if (!token) {
          console.warn('No Finnhub API key found. Add it to localStorage (FINNHUB_API_KEY).');
          setStatus('error');
          return;
        }

        ws = new WebSocket(`wss://ws.finnhub.io?token=${token}`);
        
        ws.onopen = () => {
          setStatus('connected');
          ws.send(JSON.stringify({ type: 'subscribe', symbol: symbol.toUpperCase() }));
        };

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === 'trade' && data.data?.length > 0) {
            const trade = data.data[data.data.length - 1]; // take the latest tick
            setLatestTick({
              price: trade.p,
              volume: trade.v,
              timestamp: trade.t,
            });
          }
        };
      } 
      else if (provider === 'polygon') {
        const token = localStorage.getItem('POLYGON_API_KEY') || import.meta.env.VITE_POLYGON_API_KEY;
        if (!token) {
          console.warn('No Polygon API key found. Add it to localStorage (POLYGON_API_KEY).');
          setStatus('error');
          return;
        }

        // Polygon handles stocks websocket differently based on subscription tier. 
        // delayed.polygon.io is for the free tier (15 min delayed).
        ws = new WebSocket('wss://delayed.polygon.io/stocks'); 
        
        ws.onopen = () => {
          setStatus('connected');
          ws.send(JSON.stringify({ action: 'auth', params: token }));
          ws.send(JSON.stringify({ action: 'subscribe', params: `T.${symbol.toUpperCase()}` }));
        };

        ws.onmessage = (event) => {
          const payload = JSON.parse(event.data);
          for (const data of payload) {
            if (data.ev === 'T') {
              setLatestTick({
                price: data.p,
                volume: data.s, // size
                timestamp: data.t,
              });
            }
          }
        };
      }
      else if (provider === 'yahoo') {
        console.warn('Yahoo Finance WebSocket requires protobuf parsing which is heavy for frontend. Fallback to Finnhub recommended.');
        setStatus('error');
        return;
      }

      if (ws) {
        ws.onerror = () => setStatus('error');
        ws.onclose = () => setStatus('disconnected');
        wsRef.current = ws;
      }
    } catch (err) {
      console.error('WebSocket connection failed:', err);
      setStatus('error');
    }

    return () => {
      if (wsRef.current) {
        if (provider === 'finnhub' && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'unsubscribe', symbol: symbol.toUpperCase() }));
        }
        wsRef.current.close();
      }
    };
  }, [symbol, provider]);

  return { latestTick, status };
}
