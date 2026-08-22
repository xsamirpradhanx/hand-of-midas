import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePanel, readPanel, cachedSymbols, FileBarDataSource } from './barCache.js';
import type { BacktestBar } from './types.js';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'barcache-'));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const bars: BacktestBar[] = Array.from({ length: 250 }, (_, i) => ({
  datetime: new Date(Date.parse('2020-01-02') + i * 86_400_000).toISOString(),
  open: 100 + i * 0.5, high: 101 + i * 0.5, low: 99 + i * 0.5,
  close: 100.25 + i * 0.5, volume: 1_000_000 + i,
}));

describe('bar cache round trip', () => {
  it('reads back every field exactly', () => {
    const dir = tmp();
    writePanel(dir, 'TEST', '1day', bars);
    const p = readPanel(dir, 'TEST', '1day')!;
    expect(p.n).toBe(bars.length);
    for (let i = 0; i < bars.length; i++) {
      expect(p.t[i]).toBe(Date.parse(bars[i].datetime));
      expect(p.o[i]).toBe(bars[i].open);
      expect(p.h[i]).toBe(bars[i].high);
      expect(p.l[i]).toBe(bars[i].low);
      expect(p.c[i]).toBe(bars[i].close);
      expect(p.v[i]).toBe(bars[i].volume);
    }
  });

  it('handles an empty series without producing a corrupt file', () => {
    const dir = tmp();
    writePanel(dir, 'EMPTY', '1day', []);
    expect(readPanel(dir, 'EMPTY', '1day')!.n).toBe(0);
  });

  it('returns null for a symbol that was never written', () => {
    expect(readPanel(tmp(), 'MISSING', '1day')).toBeNull();
  });

  /**
   * The cache is read with typed-array views over raw bytes, so a file that is
   * truncated or is not a cache file at all would otherwise be reinterpreted as
   * plausible-looking prices. Both are refused loudly.
   */
  it('refuses a file that is not a bar cache', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'JUNK.1day.bin'), Buffer.from('not a cache file at all'));
    expect(() => readPanel(dir, 'JUNK', '1day')).toThrow(/bad magic/);
  });

  it('refuses a truncated file rather than reading short', () => {
    const dir = tmp();
    writePanel(dir, 'CUT', '1day', bars);
    const file = path.join(dir, 'CUT.1day.bin');
    const buf = fs.readFileSync(file);
    fs.writeFileSync(file, buf.subarray(0, buf.length - 64));
    expect(() => readPanel(dir, 'CUT', '1day')).toThrow(/truncated/);
  });

  it('lists cached symbols for the requested interval only', () => {
    const dir = tmp();
    writePanel(dir, 'BBB', '1day', bars);
    writePanel(dir, 'AAA', '1day', bars);
    writePanel(dir, 'CCC', '1min', bars);
    expect(cachedSymbols(dir, '1day')).toEqual(['AAA', 'BBB']);
    expect(cachedSymbols(dir, '1min')).toEqual(['CCC']);
  });

  it('reports no symbols for a directory that does not exist', () => {
    expect(cachedSymbols(path.join(tmp(), 'nope'), '1day')).toEqual([]);
  });
});

describe('FileBarDataSource', () => {
  it('serves the same bars the store would, honouring date bounds', async () => {
    const dir = tmp();
    writePanel(dir, 'TEST', '1day', bars);
    const src = new FileBarDataSource({ dir, from: bars[10].datetime, to: bars[20].datetime });
    const out = await src.bars('TEST');
    expect(out.length).toBe(11);
    expect(out[0].close).toBe(bars[10].close);
    expect(out[10].close).toBe(bars[20].close);
  });

  it('drops symbols with too little history to support a replay', async () => {
    const dir = tmp();
    writePanel(dir, 'LONG', '1day', bars);
    writePanel(dir, 'SHORT', '1day', bars.slice(0, 20));
    const src = new FileBarDataSource({ dir, minBars: 100 });
    expect(await src.symbols()).toEqual(['LONG']);
  });

  it('returns nothing for an uncached symbol instead of throwing', async () => {
    expect(await new FileBarDataSource({ dir: tmp() }).bars('GONE')).toEqual([]);
  });
});
