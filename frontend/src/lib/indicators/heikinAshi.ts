export interface HeikinAshiBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export function calculateHeikinAshi(data: any[]): any[] {
  if (!data || data.length === 0) return [];

  const haData: any[] = [];
  
  // Find the first valid data point
  let firstValidIdx = 0;
  while (firstValidIdx < data.length && data[firstValidIdx].close === undefined) {
    firstValidIdx++;
  }
  
  if (firstValidIdx >= data.length) {
    return data.map(d => ({ time: d.time }));
  }

  const first = data[firstValidIdx];
  let prevHaClose = (first.open + first.high + first.low + first.close) / 4;
  let prevHaOpen = (first.open + first.close) / 2;

  // Add whitespace points that might exist before the first valid point
  for (let i = 0; i < firstValidIdx; i++) {
    haData.push({ time: data[i].time });
  }

  haData.push({
    time: first.time,
    open: prevHaOpen,
    high: Math.max(first.high, prevHaOpen, prevHaClose),
    low: Math.min(first.low, prevHaOpen, prevHaClose),
    close: prevHaClose,
  });

  for (let i = firstValidIdx + 1; i < data.length; i++) {
    const curr = data[i];
    
    // If it's a whitespace data point (no price), just pass it through
    if (curr.close === undefined) {
      haData.push({ time: curr.time });
      continue;
    }

    const haClose = (curr.open + curr.high + curr.low + curr.close) / 4;
    const haOpen = (prevHaOpen + prevHaClose) / 2;
    const haHigh = Math.max(curr.high, haOpen, haClose);
    const haLow = Math.min(curr.low, haOpen, haClose);

    haData.push({
      time: curr.time,
      open: haOpen,
      high: haHigh,
      low: haLow,
      close: haClose,
    });

    prevHaClose = haClose;
    prevHaOpen = haOpen;
  }

  return haData;
}
