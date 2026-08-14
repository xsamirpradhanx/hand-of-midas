// ---------------------------------------------------------------------------
// Market Holidays
// ---------------------------------------------------------------------------

/**
 * @deprecated The manual holiday list has been removed. 
 * An exchange-calendar service (e.g. \`date-holidays\`) should be integrated for robust 
 * holiday and early-close detection. For now, we only exclude weekends.
 */
const MARKET_HOLIDAYS: string[] = [];

export type MarketSession = 'PREMARKET' | 'REGULAR' | 'CLOSED';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatToDateStr(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getETDate(date: Date = new Date()): Date {
  const etStr = date.toLocaleString('en-US', { timeZone: 'America/New_York' });
  return new Date(etStr);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if the given date is a trading day (Mon-Fri, not a holiday).
 */
export function isTradingDay(date: Date): boolean {
  const day = date.getDay();
  if (day === 0 || day === 6) {
    return false; // Weekend
  }
  
  const dateStr = formatToDateStr(date);
  if (MARKET_HOLIDAYS.includes(dateStr)) {
    return false;
  }
  
  return true;
}

/**
 * Returns the number of TRADING DAYS between today and the expiration date.
 * Expirations are at market close (16:00 ET).
 */
export function getDTE(expirationDateStr: string): number {
  const nowET = getETDate();
  const todayStr = formatToDateStr(nowET);
  
  if (expirationDateStr < todayStr) {
    return 0; // already expired
  }
  
  if (expirationDateStr === todayStr) {
    const hoursET = nowET.getHours();
    const minutesET = nowET.getMinutes();
    // After 16:00 ET
    if (hoursET >= 16) {
      return 0;
    }
    return 0; // Same day is 0 DTE
  }

  let dte = 0;
  const current = new Date(todayStr + 'T00:00:00');
  const expiry = new Date(expirationDateStr + 'T00:00:00');

  // Start checking from tomorrow up to and including expiration
  current.setDate(current.getDate() + 1);
  while (current <= expiry) {
    if (isTradingDay(current)) {
      dte++;
    }
    current.setDate(current.getDate() + 1);
  }

  return dte;
}

/**
 * Returns true if US equity market is currently open.
 * Market hours: 09:30-16:00 ET, Mon-Fri, excluding holidays.
 */
export function isMarketOpen(): boolean {
  return getMarketSession() === 'REGULAR';
}

/**
 * Returns the US equity session in Eastern Time. Keep this server-side so an
 * old browser tab cannot force premarket filters during regular hours.
 */
export function getMarketSession(date: Date = new Date()): MarketSession {
  // Do not parse a formatted ET timestamp back into Date: Lambda normally runs
  // in UTC, which would reinterpret 14:30 ET as 14:30 UTC. Read ET parts
  // directly instead.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? '';
  const weekday = value('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return 'CLOSED';

  const minutes = Number(value('hour')) * 60 + Number(value('minute'));
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return 'PREMARKET';
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return 'REGULAR';
  return 'CLOSED';
}

/**
 * Returns the next market open time as a Date.
 */
export function nextMarketOpen(): Date {
  let date = getETDate();
  
  // If we're before market open today, and it's a trading day, return today at 09:30 ET
  if (isTradingDay(date)) {
    const time = date.getHours() * 100 + date.getMinutes();
    if (time < 930) {
      const openTime = new Date(date);
      openTime.setHours(9, 30, 0, 0);
      return openTime;
    }
  }
  
  // Otherwise, find the next trading day
  date.setDate(date.getDate() + 1);
  while (!isTradingDay(date)) {
    date.setDate(date.getDate() + 1);
  }
  
  date.setHours(9, 30, 0, 0);
  return date;
}

/**
 * Returns the number of calendar days between today and expiration.
 */
export function getCalendarDTE(expirationDateStr: string): number {
  const nowET = getETDate();
  nowET.setHours(0, 0, 0, 0);
  
  const expiryET = new Date(expirationDateStr + 'T00:00:00');
  
  const diffTime = expiryET.getTime() - nowET.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
  
  return diffDays > 0 ? diffDays : 0;
}

/**
 * Model time in years for option valuation.  Black-Scholes convention is
 * calendar time / 365; trading DTE must not be divided by 365.
 */
export function getTimeToExpiryYears(expirationDateStr: string): number {
  return Math.max(0, getCalendarDTE(expirationDateStr) / 365);
}
