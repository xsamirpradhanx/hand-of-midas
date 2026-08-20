import { evaluateQuant } from './scripts/evaluateQuant.js';
import { captureIntraday } from './services/backtest/intradayCapture.js';
import { handler as screenerRefreshHandler } from './handlers/screenerRefresh.js';
import { handler as diagonalRefreshHandler } from './handlers/diagonalRefresh.js';
import { handler as valueRefreshHandler } from './handlers/valueRefresh.js';
import { handler as growthRefreshHandler } from './handlers/growthRefresh.js';
import { handler as etfRefreshHandler } from './handlers/etfRefresh.js';
import type { ScreenerMode } from './services/screenerService.js';

/**
 * Local-dev-only background job scheduler. Nothing here runs in the deployed
 * Lambdas — this exists so quant grading (and future jobs) can run
 * periodically while `npm run dev` is up, without deploying anything to AWS.
 * Each job is off by default and toggled via the /local/scheduler routes in
 * local.ts (or LOCAL_<JOB>_ENABLED=true in .env to default it on at startup).
 */

interface JobHandle {
  name: string;
  intervalMinutes: number;
  running: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  start(): void;
  stop(): void;
}

const jobs = new Map<string, JobHandle>();

function registerJob(name: string, defaultIntervalMinutes: number, fn: () => Promise<void>): JobHandle {
  const intervalMinutes = Number(process.env[`LOCAL_${name.toUpperCase().replace(/-/g, '_')}_INTERVAL_MINUTES`]) || defaultIntervalMinutes;
  let timer: NodeJS.Timeout | null = null;

  const job: JobHandle = {
    name,
    intervalMinutes,
    running: false,
    lastRunAt: null,
    lastError: null,
    start() {
      if (timer) return;
      const run = async () => {
        console.log(`[LocalScheduler] Running ${name}...`);
        try {
          await fn();
          job.lastRunAt = new Date().toISOString();
          job.lastError = null;
          console.log(`[LocalScheduler] ${name} completed.`);
        } catch (err) {
          job.lastError = err instanceof Error ? err.message : String(err);
          console.error(`[LocalScheduler] ${name} failed:`, err);
        }
      };
      timer = setInterval(run, intervalMinutes * 60_000);
      job.running = true;
      console.log(`[LocalScheduler] ${name} enabled — running now, then every ${intervalMinutes}m.`);
      run();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      job.running = false;
      console.log(`[LocalScheduler] ${name} disabled.`);
    },
  };

  jobs.set(name, job);
  return job;
}

// Daily-bar grading doesn't benefit from running more than a few times a day
// locally, but a short default makes the toggle easy to see working.
export const evaluateQuantJob = registerJob('evaluate-quant', 30, evaluateQuant);

if (process.env.LOCAL_EVALUATE_QUANT_ENABLED === 'true') {
  evaluateQuantJob.start();
}

// Mirrors ScreenerRefreshFunction in production (see handofmidas-stack.ts):
// GET /api/screener only ever reads the cache now, since a full deep scan
// takes 3+ minutes — something has to populate it. One job per mode so they
// can be toggled/observed independently, same as production's staggered
// per-mode EventBridge rules. Intervals match the prod cron cadence per mode.
const SCREENER_MODE_INTERVAL_MINUTES: Record<ScreenerMode, number> = {
  open: 5,
  premarket: 5,
  momentum: 2,
  highdemand: 2,
};
export const screenerRefreshJobs = (Object.keys(SCREENER_MODE_INTERVAL_MINUTES) as ScreenerMode[]).map(mode =>
  registerJob(`screener-refresh-${mode}`, SCREENER_MODE_INTERVAL_MINUTES[mode], () => screenerRefreshHandler({ mode })),
);

if (process.env.LOCAL_SCREENER_REFRESH_ENABLED === 'true') {
  screenerRefreshJobs.forEach(job => job.start());
}

// Mirrors DiagonalRefreshFunction: same reasoning, same "cache-only route"
// pattern, but a single cadence since there's only one mode.
export const diagonalRefreshJob = registerJob('diagonal-refresh', 15, diagonalRefreshHandler);

if (process.env.LOCAL_SCREENER_REFRESH_ENABLED === 'true') {
  diagonalRefreshJob.start();
}

// Mirrors Value/Growth/EtfRefreshFunction: fundamentals and multi-month ETF
// performance don't move intraday, so a once-daily cadence (1440m) matches
// the prod cron intent without needing a real day boundary check locally.
export const valueRefreshJob = registerJob('value-refresh', 1440, valueRefreshHandler);
export const growthRefreshJob = registerJob('growth-refresh', 1440, growthRefreshHandler);
export const etfRefreshJob = registerJob('etf-refresh', 1440, etfRefreshHandler);

if (process.env.LOCAL_SCREENER_REFRESH_ENABLED === 'true') {
  valueRefreshJob.start();
  growthRefreshJob.start();
  etfRefreshJob.start();
}

// Rolling intraday capture. Schwab only exposes ~31 days of minute bars, so
// intraday history cannot be backfilled — it has to be accumulated forward from
// today. This job runs here rather than in a Lambda because it needs the local
// .schwab_token.json: Schwab refresh tokens expire after 7 days and the stack
// doesn't carry Schwab credentials. Once daily is enough — each run re-reads a
// trailing multi-day window, so a missed day heals on the next run.
export const intradayCaptureJob = registerJob('intraday-capture', 1440, async () => {
  await captureIntraday();
});

if (process.env.LOCAL_INTRADAY_CAPTURE_ENABLED === 'true') {
  intradayCaptureJob.start();
}

export function getJob(name: string): JobHandle | undefined {
  return jobs.get(name);
}

export function listJobs(): Array<Pick<JobHandle, 'name' | 'intervalMinutes' | 'running' | 'lastRunAt' | 'lastError'>> {
  return Array.from(jobs.values()).map(({ name, intervalMinutes, running, lastRunAt, lastError }) => ({
    name, intervalMinutes, running, lastRunAt, lastError,
  }));
}
