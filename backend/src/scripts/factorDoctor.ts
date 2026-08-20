/**
 * Factor Doctor — runs every registered factor against live data and reports health.
 *
 *   npm run factor-doctor                 # default symbol set
 *   SYMS=NVDA,GLD,JPM npm run factor-doctor
 *
 * Statuses:
 *   ✅  produces a directional read at least sometimes
 *   🔇  always-neutral across the sample — either a by-design non-voter
 *       (FactorResult.directional === false) or a threshold that never fires
 *   ⚠️  always null — missing input or a broken dependency
 *   ❌  throws
 *
 * `neutralPct` is the number that matters most: a factor that is technically
 * "working" but neutral 100% of the time contributes nothing directional, and
 * this is how Volatility Term Structure was caught returning null on every
 * symbol (a front-expiry-only chain snapshot could never build the >=2 points
 * it needs).
 */
import 'dotenv/config';
import { getFactors } from '../services/factors/factorRegistry.js';
import { fetchBarsWithFallback } from '../services/marketData/fetchBars.js';
import { fetchOptionsChainWithFallback } from '../services/optionsFallback.js';
import { getAggregatedSentiment } from '../services/sentimentAggregator.js';
import { getTickerNews } from '../services/polygon.js';
import type { FactorInput } from '../services/factors/types.js';

const SYMBOLS = (process.env.SYMS ?? 'AAPL,NVDA,TSM,AMD').split(',');
async function main() {
  const factors = getFactors();
  const t: Record<string,{ok:number;nul:number;threw:number;bull:number;bear:number;neu:number;w:number[];err:string[]}> = {};
  for (const sym of SYMBOLS) {
    let bars:any, intradayBars:any, optionsChain:any, sentiment:any, news:any;
    try { ({bars} = await fetchBarsWithFallback(sym,'1day',126,{preferredProvider:'yahoo'})); } catch { continue; }
    try { ({bars: intradayBars} = await fetchBarsWithFallback(sym,'1min',960,{extendedHours:true})); } catch {}
    try { optionsChain = await fetchOptionsChainWithFallback(sym); } catch {}
    try { sentiment = await getAggregatedSentiment(sym); } catch {}
    try { news = await getTickerNews(sym,15); } catch {}
    const input: FactorInput = { symbol:sym, currentPrice:bars[bars.length-1].close, bars, intradayBars,
      optionsChain, activeExpiry: optionsChain?.expirations?.[0], sentiment, news };
    console.log(`${sym}: news=${news?.length??0} sentiment=${sentiment?'yes':'no'} opt=${optionsChain?.expirations?.length??0}`);
    for (const f of factors) {
      t[f.name] ??= {ok:0,nul:0,threw:0,bull:0,bear:0,neu:0,w:[],err:[]};
      try {
        const r = await f.evaluate(input);
        if (!r) { t[f.name].nul++; continue; }
        t[f.name].ok++; t[f.name].w.push(r.weight);
        if (r.bias==='bullish') t[f.name].bull++; else if (r.bias==='bearish') t[f.name].bear++; else t[f.name].neu++;
      } catch(e:any){ t[f.name].threw++; const m=(e?.message??String(e)).slice(0,60); if(!t[f.name].err.includes(m)) t[f.name].err.push(m); }
    }
  }
  const rows = Object.entries(t).map(([name,v])=>{
    const directional = v.bull+v.bear;
    return { factor:name.slice(0,40), ok:v.ok, nul:v.nul, threw:v.threw,
      dir:directional, neu:v.neu,
      neutralPct: v.ok? Math.round(v.neu/v.ok*100)+'%' : '-',
      avgW: v.w.length? (v.w.reduce((a,b)=>a+b,0)/v.w.length).toFixed(2):'-',
      status: v.threw?'❌throws': v.ok===0?'⚠️dead': v.neu===v.ok?'🔇always-neutral':'✅',
      err:v.err[0]??'' };
  });
  rows.sort((a,b)=> a.status.localeCompare(b.status));
  console.table(rows);
  const c=(s:string)=>rows.filter(r=>r.status.includes(s)).length;
  console.log(`\n✅ contributing: ${c('✅')}   🔇 always-neutral: ${c('always-neutral')}   ⚠️ dead: ${c('dead')}   ❌ throws: ${c('throws')}   / ${rows.length}`);
}
main();
