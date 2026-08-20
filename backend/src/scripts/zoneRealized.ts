/** Joins zoneAudit rows to realized forward bars + naive placebo benchmarks. */
import 'dotenv/config';
import { fetchBarsWithFallback } from '../services/marketData/fetchBars.js';
import * as fs from 'node:fs';
const HORIZON = 20;
const rows = fs.readFileSync(process.env.IN ?? '/tmp/zoneaudit.jsonl','utf8').trim().split('\n').map(l=>JSON.parse(l));
const bySym: Record<string, any[]> = {};
for (const r of rows) (bySym[r.symbol] ??= []).push(r);
const out: any[] = [];
for (const sym of Object.keys(bySym)) {
  let bars: any[];
  try { ({bars} = await fetchBarsWithFallback(sym,'1day',400,{preferredProvider:'yahoo'})); } catch { continue; }
  const idx = new Map<string,number>();
  bars.forEach((b,i)=> idx.set(String(b.datetime).slice(0,10), i));
  for (const r of bySym[sym]) {
    const i = idx.get(r.asOf); if (i==null) continue;
    const fut = bars.slice(i+1, i+1+HORIZON); if (fut.length<HORIZON) continue;
    const hist = bars.slice(Math.max(0,i-13), i+1);
    // True Wilder-ish ATR14 from visible history only
    let trs=[]; for(let k=1;k<hist.length;k++){const p=hist[k-1],c=hist[k];
      trs.push(Math.max(c.high-c.low, Math.abs(c.high-p.close), Math.abs(c.low-p.close)));}
    const atr = trs.reduce((a,b)=>a+b,0)/Math.max(1,trs.length);
    out.push({...r, atrAbs:+atr.toFixed(4),
      futLow:+Math.min(...fut.map((b:any)=>b.low)).toFixed(4),
      futHigh:+Math.max(...fut.map((b:any)=>b.high)).toFixed(4),
      futClose:+fut[fut.length-1].close.toFixed(4)});
  }
  console.error(sym+' ok');
}
fs.writeFileSync(process.env.OUT ?? '/tmp/zonereal.jsonl', out.map(o=>JSON.stringify(o)).join('\n'));
console.error('WROTE '+out.length);
