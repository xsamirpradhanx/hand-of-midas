/**
 * One-shot intraday capture, for seeding the store or running it by hand.
 *
 *   npm run capture-intraday
 *   npm run capture-intraday -- --symbols=SPY,AAPL --interval=5min --days=31
 *
 * The scheduled version is `intraday-capture` in localScheduler.ts; this exists
 * so the first seed (which pulls the full ~31 days Schwab still holds) can be
 * run deliberately rather than waiting for a cron tick.
 */
import 'dotenv/config';

import 'dotenv/config';
import { captureIntraday } from '../services/backtest/intradayCapture.js';
import type { BarInterval } from '../services/marketData/fetchBars.js';

const argv = process.argv.slice(2);
const get = (name: string) => argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];

const symbols = get('symbols')?.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const days = get('days') ? Number(get('days')) : undefined;

const result = await captureIntraday({
  ...(symbols ? { symbols } : {}),
  ...(get('interval') ? { interval: get('interval') as BarInterval } : {}),
  ...(days !== undefined ? { trailingDays: days } : {}),
});

if (result.failed.length) process.exitCode = 1;
