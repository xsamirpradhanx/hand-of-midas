import type { OHLCVBar } from './types';

export interface FibLevel {
  level: number;
  price: number;
  label: string;
}

export function calculateFibonacci(data: OHLCVBar[]): FibLevel[] {
  if (!data || data.length === 0) {
    return [];
  }

  let high = -Infinity;
  let low = Infinity;
  let highIndex = -1;
  let lowIndex = -1;

  for (let i = 0; i < data.length; i++) {
    if (data[i].high > high) {
      high = data[i].high;
      highIndex = i;
    }
    if (data[i].low < low) {
      low = data[i].low;
      lowIndex = i;
    }
  }

  const isUptrend = lowIndex <= highIndex;
  const diff = high - low;

  const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
  const results: FibLevel[] = [];

  const getLabel = (lvl: number) => {
    if (lvl === 0) return '0%';
    if (lvl === 1) return '100%';
    return `${(lvl * 100).toFixed(1)}%`;
  };

  for (const level of levels) {
    let price: number;
    if (isUptrend) {
      // 0% = swing low, 100% = swing high
      price = low + diff * level;
    } else {
      // 0% = swing high, 100% = swing low
      price = high - diff * level;
    }
    
    results.push({
      level,
      price,
      label: getLabel(level),
    });
  }

  return results;
}
