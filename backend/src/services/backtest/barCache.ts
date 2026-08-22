/**
 * Local mirror of the daily bar store.
 *
 * The DynamoDB store is the source of truth, but it is the wrong shape for
 * indicator research. Measuring one candidate indicator over the full panel
 * means touching every bar of every symbol; served from Dynamo that is ~10k
 * item reads and tens of seconds before a single number comes back, which caps
 * how many ideas can be tried in a session. Research that slow does not get
 * done iteratively — it gets done once.
 *
 * So the panel is mirrored to disk once and read back as typed arrays: a full
 * 2.2M-bar load is well under a second and costs nothing per run.
 *
 * FORMAT (per symbol, `<CACHE>/<SYMBOL>.<interval>.bin`):
 *
 *   bytes 0..3   magic 'HMB1'
 *   bytes 4..7   uint32 bar count
 *   bytes 8..    six little-endian Float64Array blocks of `count` values,
 *                in order: t (epoch ms), o, h, l, c, v
 *
 * Columnar and binary for the same reason the Dynamo chunks are: a bar is six
 * numbers, and any per-bar object costs more in parse time than the numbers
 * themselves. Float64 for `t` rather than a 64-bit int keeps every block the
 * same width, so the reader is one loop with no special cases; epoch
 * milliseconds are exactly representable in a double until well past year 10000.
 *
 * The cache is DERIVED and disposable. It is gitignored, never written by the
 * live path, and can be rebuilt at any time from the store.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getBars } from './barStore.js';
import { listStoredSymbols } from './dynamoDataSource.js';
import type { BacktestBar, BacktestDataSource } from './types.js';
import type { BarInterval } from '../marketData/fetchBars.js';

const MAGIC = 0x484d4231; // 'HMB1'
const HEADER_BYTES = 8;
const COLUMNS = 6;

export const DEFAULT_CACHE_DIR = new URL('../../../.barcache/', import.meta.url).pathname;

/** Columnar bars, the shape every lab computation actually wants. */
export interface BarPanel {
  readonly symbol: string;
  readonly n: number;
  readonly t: Float64Array;
  readonly o: Float64Array;
  readonly h: Float64Array;
  readonly l: Float64Array;
  readonly c: Float64Array;
  readonly v: Float64Array;
}

function cacheFile(dir: string, symbol: string, interval: BarInterval): string {
  return path.join(dir, `${symbol.toUpperCase()}.${interval}.bin`);
}

export function writePanel(dir: string, symbol: string, interval: BarInterval, bars: readonly BacktestBar[]): void {
  fs.mkdirSync(dir, { recursive: true });
  const n = bars.length;
  const buf = Buffer.allocUnsafe(HEADER_BYTES + COLUMNS * n * 8);
  buf.writeUInt32BE(MAGIC, 0);
  buf.writeUInt32LE(n, 4);
  const view = new Float64Array(buf.buffer, buf.byteOffset + HEADER_BYTES, COLUMNS * n);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    view[i] = Date.parse(b.datetime);
    view[n + i] = b.open;
    view[2 * n + i] = b.high;
    view[3 * n + i] = b.low;
    view[4 * n + i] = b.close;
    view[5 * n + i] = b.volume;
  }
  fs.writeFileSync(cacheFile(dir, symbol, interval), buf);
}

export function readPanel(dir: string, symbol: string, interval: BarInterval = '1day'): BarPanel | null {
  const file = cacheFile(dir, symbol, interval);
  let buf: Buffer;
  try { buf = fs.readFileSync(file); } catch { return null; }
  if (buf.length < HEADER_BYTES || buf.readUInt32BE(0) !== MAGIC) {
    throw new Error(`${file}: not a bar cache file (bad magic) — delete it and re-export`);
  }
  const n = buf.readUInt32LE(4);
  const expected = HEADER_BYTES + COLUMNS * n * 8;
  if (buf.length !== expected) {
    throw new Error(`${file}: truncated (${buf.length}B, expected ${expected}B) — re-export`);
  }
  // `slice` on the underlying ArrayBuffer copies, which both fixes any
  // alignment the file read happened to land on and detaches the panel from
  // the Buffer so it can be freed.
  const all = new Float64Array(buf.buffer.slice(buf.byteOffset + HEADER_BYTES, buf.byteOffset + expected));
  const col = (k: number) => all.subarray(k * n, (k + 1) * n);
  return { symbol, n, t: col(0), o: col(1), h: col(2), l: col(3), c: col(4), v: col(5) };
}

/** Symbols present in the cache, sorted. */
export function cachedSymbols(dir: string = DEFAULT_CACHE_DIR, interval: BarInterval = '1day'): string[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const suffix = `.${interval}.bin`;
  return names.filter(f => f.endsWith(suffix)).map(f => f.slice(0, -suffix.length)).sort();
}

export interface ExportProgress { symbol: string; index: number; total: number; bars: number }

/**
 * Mirror the store to disk. Returns the number of bars written.
 *
 * Symbols already cached are skipped unless `force`, so a re-export after a
 * partial failure resumes rather than re-reading forty years per name.
 */
export async function exportCache(options: {
  dir?: string;
  interval?: BarInterval;
  symbols?: readonly string[];
  force?: boolean;
  onProgress?: (p: ExportProgress) => void;
} = {}): Promise<{ symbols: number; bars: number }> {
  const dir = options.dir ?? DEFAULT_CACHE_DIR;
  const interval = options.interval ?? '1day';
  const universe = options.symbols ?? (await listStoredSymbols(interval));
  let bars = 0;
  let written = 0;
  for (let i = 0; i < universe.length; i++) {
    const symbol = universe[i].toUpperCase();
    if (!options.force && fs.existsSync(cacheFile(dir, symbol, interval))) {
      const existing = readPanel(dir, symbol, interval);
      if (existing) {
        bars += existing.n;
        written++;
        options.onProgress?.({ symbol, index: i, total: universe.length, bars: existing.n });
        continue;
      }
    }
    const series = await getBars(symbol, interval);
    writePanel(dir, symbol, interval, series);
    bars += series.length;
    written++;
    options.onProgress?.({ symbol, index: i, total: universe.length, bars: series.length });
  }
  return { symbols: written, bars };
}

/**
 * `BacktestDataSource` over the local cache.
 *
 * Interchangeable with `DynamoBarDataSource` — same contract, same series —
 * so the existing replay harness can run off the mirror without knowing.
 */
export class FileBarDataSource implements BacktestDataSource {
  private readonly dir: string;
  private readonly interval: BarInterval;
  private readonly fromMs: number;
  private readonly toMs: number;
  private readonly minBars: number;
  private readonly requested?: readonly string[];

  constructor(options: {
    dir?: string;
    interval?: BarInterval;
    symbols?: readonly string[];
    from?: string;
    to?: string;
    minBars?: number;
  } = {}) {
    this.dir = options.dir ?? DEFAULT_CACHE_DIR;
    this.interval = options.interval ?? '1day';
    this.requested = options.symbols;
    this.fromMs = options.from ? Date.parse(options.from) : -Infinity;
    this.toMs = options.to ? Date.parse(options.to) : Infinity;
    this.minBars = options.minBars ?? 0;
  }

  async symbols(): Promise<string[]> {
    const candidates = this.requested
      ? this.requested.map(s => s.toUpperCase())
      : cachedSymbols(this.dir, this.interval);
    if (this.minBars <= 0) return [...candidates];
    return candidates.filter(s => {
      const p = readPanel(this.dir, s, this.interval);
      return p !== null && p.n >= this.minBars;
    });
  }

  async bars(symbol: string): Promise<BacktestBar[]> {
    const p = readPanel(this.dir, symbol, this.interval);
    if (!p) return [];
    const out: BacktestBar[] = [];
    for (let i = 0; i < p.n; i++) {
      if (p.t[i] < this.fromMs || p.t[i] > this.toMs) continue;
      out.push({
        datetime: new Date(p.t[i]).toISOString(),
        open: p.o[i], high: p.h[i], low: p.l[i], close: p.c[i], volume: p.v[i],
      });
    }
    return out;
  }
}
