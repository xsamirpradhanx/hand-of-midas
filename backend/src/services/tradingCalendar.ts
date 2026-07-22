// ---------------------------------------------------------------------------
// Market Holidays
// ---------------------------------------------------------------------------

const MARKET_HOLIDAYS: string[] = [
  '2024-01-01', // New Year's Day
  '2024-01-15', // MLK Day
  '2024-02-19', // Presidents Day
  '2024-03-29', // Good Friday
  '2024-05-27', // Memorial Day
  '2024-06-19', // Juneteenth
  '2024-07-04', // Independence Day
  '2024-09-02', // Labor Day
  '2024-11-28', // Thanksgiving
  '2024-12-25', // Christmas
  '2025-01-01', // New Year's Day
  '2025-01-20', // MLK Day
  '2025-02-17', // Presidents Day
  '2025-04-18', // Good Friday
  '2025-05-26', // Memorial Day
  '2025-06-19', // Juneteenth
  '2025-07-04', // Independence Day
  '2025-09-01', // Labor Day
  '2025-11-27', // Thanksgiving
  '2025-12-25', // Christmas
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
  '2027-01-01', // New Year's Day
  '2027-01-18', // MLK Day
  '2027-02-15', // Presidents Day
  '2027-03-26', // Good Friday
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth (observed)
  '2027-07-05', // Independence Day (observed)
  '2027-09-06', // Labor Day
  '2027-11-25', // Thanksgiving
  '2027-12-24', // Christmas (observed)
];

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
  const nowET = getETDate();
  
  if (!isTradingDay(nowET)) {
    return false;
  }
  
  const hours = nowET.getHours();
  const minutes = nowET.getMinutes();
  const time = hours * 100 + minutes;
  
  return time >= 930 && time < 1600;
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
