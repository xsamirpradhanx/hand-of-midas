import type { OHLCVBar } from './types';

export interface ADXResult {
  time: string | number;
  plusDI: number;
  minusDI: number;
  adx: number;
}

export function calculateADX(data: OHLCVBar[], period: number = 14): ADXResult[] {
  if (!data || data.length < period * 2) {
    return [];
  }

  const result: ADXResult[] = [];
  const trValues: number[] = [];
  const plusDMValues: number[] = [];
  const minusDMValues: number[] = [];

  // 1 & 2. Calculate TR, +DM, -DM
  for (let i = 0; i < data.length; i++) {
    const currentHigh = data[i].high;
    const currentLow = data[i].low;

    if (i === 0) {
      trValues.push(currentHigh - currentLow);
      plusDMValues.push(0);
      minusDMValues.push(0);
      continue;
    }

    const prevHigh = data[i - 1].high;
    const prevLow = data[i - 1].low;
    const prevClose = data[i - 1].close;

    // True Range
    const hl = currentHigh - currentLow;
    const hpc = Math.abs(currentHigh - prevClose);
    const lpc = Math.abs(currentLow - prevClose);
    trValues.push(Math.max(hl, hpc, lpc));

    // Directional Movement
    const upMove = currentHigh - prevHigh;
    const downMove = prevLow - currentLow;

    if (upMove > downMove && upMove > 0) {
      plusDMValues.push(upMove);
    } else {
      plusDMValues.push(0);
    }

    if (downMove > upMove && downMove > 0) {
      minusDMValues.push(downMove);
    } else {
      minusDMValues.push(0);
    }
  }

  // 3. Smooth TR, +DM, -DM
  // Initial smoothed values are sum of first period values (skipping index 0 usually, but let's just sum index 1 to period)
  let smoothedTR = 0;
  let smoothedPlusDM = 0;
  let smoothedMinusDM = 0;

  for (let i = 1; i <= period; i++) {
    smoothedTR += trValues[i];
    smoothedPlusDM += plusDMValues[i];
    smoothedMinusDM += minusDMValues[i];
  }

  const dxValues: number[] = [];
  // For the first period we have our first smoothed values. We can calculate first DX.
  let plusDI = (smoothedPlusDM / smoothedTR) * 100;
  let minusDI = (smoothedMinusDM / smoothedTR) * 100;
  let dx = 0;
  if (plusDI + minusDI !== 0) {
    dx = (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;
  }
  
  // To match typical length we pad DX arrays. But we only need DX from index 'period' onwards
  // Let's store DX at the corresponding index
  const allDX: number[] = new Array(data.length).fill(0);
  allDX[period] = dx;

  // Calculate rest of smoothed TR, DM and DX
  for (let i = period + 1; i < data.length; i++) {
    smoothedTR = smoothedTR - (smoothedTR / period) + trValues[i];
    smoothedPlusDM = smoothedPlusDM - (smoothedPlusDM / period) + plusDMValues[i];
    smoothedMinusDM = smoothedMinusDM - (smoothedMinusDM / period) + minusDMValues[i];

    plusDI = (smoothedPlusDM / smoothedTR) * 100;
    minusDI = (smoothedMinusDM / smoothedTR) * 100;

    dx = 0;
    if (plusDI + minusDI !== 0) {
      dx = (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;
    }
    allDX[i] = dx;
  }

  // Calculate ADX (Smoothed DX)
  // First ADX is the simple average of first 'period' DX values
  // We have DX from index `period` to `period + period - 1`
  let sumDX = 0;
  const adxStartIndex = period * 2 - 1;
  for (let i = period; i <= adxStartIndex; i++) {
    sumDX += allDX[i];
  }
  let adx = sumDX / period;

  // Let's go back and re-calculate the final DIs so we can match them with ADX outputs
  // Actually we need +DI and -DI to match the ADX index.
  // Let's recalculate or just compute in one pass:
  
  // Re-run the loop from adxStartIndex to get result array.
  // Wait, we already consumed all data for TR/DM.
  // Better to structure it cleanly:

  // We have arrays of smoothed TR, DM for each index
  const finalPlusDI: number[] = new Array(data.length).fill(0);
  const finalMinusDI: number[] = new Array(data.length).fill(0);

  // Reconstruct the smoothed DIs for the final output array
  let sTR = 0;
  let sPlus = 0;
  let sMinus = 0;
  for (let i = 1; i <= period; i++) {
    sTR += trValues[i];
    sPlus += plusDMValues[i];
    sMinus += minusDMValues[i];
  }
  finalPlusDI[period] = (sPlus / sTR) * 100;
  finalMinusDI[period] = (sMinus / sTR) * 100;

  for (let i = period + 1; i < data.length; i++) {
    sTR = sTR - (sTR / period) + trValues[i];
    sPlus = sPlus - (sPlus / period) + plusDMValues[i];
    sMinus = sMinus - (sMinus / period) + minusDMValues[i];
    finalPlusDI[i] = (sPlus / sTR) * 100;
    finalMinusDI[i] = (sMinus / sTR) * 100;
  }

  result.push({
    time: data[adxStartIndex].time,
    plusDI: finalPlusDI[adxStartIndex],
    minusDI: finalMinusDI[adxStartIndex],
    adx: adx,
  });

  // Calculate subsequent ADX values
  for (let i = adxStartIndex + 1; i < data.length; i++) {
    adx = (adx * (period - 1) + allDX[i]) / period;
    result.push({
      time: data[i].time,
      plusDI: finalPlusDI[i],
      minusDI: finalMinusDI[i],
      adx: adx,
    });
  }

  return result;
}
