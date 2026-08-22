import { describe, it, expect, vi, beforeEach } from 'vitest';

// The store is exercised against an in-memory stand-in for the table so the
// chunking, merge and range logic can be tested without AWS. Every assertion
// below is about behaviour that would silently corrupt a backtest if wrong.
const table = new Map<string, any>();

vi.mock('../dynamodb.js', () => ({
  getItem: vi.fn(async (pk: string, sk: string) => table.get(`${pk}|${sk}`)),
  putItem: vi.fn(async (item: any) => { table.set(`${item.pk}|${item.sk}`, item); }),
  queryItems: vi.fn(async (pk: string, skPrefix?: string) =>
    Array.from(table.values()).filter(i => i.pk === pk && (!skPrefix || i.sk.startsWith(skPrefix)))),
  queryItemsBetween: vi.fn(async (pk: string, from: string, to: string) =>
    Array.from(table.values()).filter(i => i.pk === pk && i.sk >= from && i.sk <= to)),
}));

const { putBars, getBars, getCoverage, chunkIdFor, etDateString } = await import('./barStore.js');

const bar = (isoDate: string, close: number) => ({
  timestamp: Date.parse(`${isoDate}T20:00:00Z`), // 16:00 ET, a regular-session close
  open: close - 1, high: close + 1, low: close - 2, close, volume: 1000,
});

beforeEach(() => table.clear());

describe('chunk boundaries', () => {
  it('chunks daily bars by calendar year', () => {
    expect(chunkIdFor('1day', Date.parse('1998-03-04T20:00:00Z'))).toBe('1998');
  });

  it('chunks minute bars by ET session date', () => {
    expect(chunkIdFor('1min', Date.parse('2026-08-19T14:30:00Z'))).toBe('2026-08-19');
  });

  it('keeps a late after-hours bar in the ET session that produced it', () => {
    // 20:00 ET on Aug 19 is 00:00 UTC on Aug 20 — UTC chunking would split the
    // session across two items and break any per-session read.
    expect(etDateString(Date.parse('2026-08-20T00:00:00Z'))).toBe('2026-08-19');
    expect(chunkIdFor('1min', Date.parse('2026-08-20T00:00:00Z'))).toBe('2026-08-19');
  });
});

describe('putBars', () => {
  it('round-trips bars through the columnar encoding', async () => {
    await putBars('AAPL', '1day', [bar('2020-01-02', 100), bar('2020-01-03', 101)], 'schwab');
    const out = await getBars('AAPL', '1day');
    expect(out).toHaveLength(2);
    expect(out[0]!.close).toBe(100);
    expect(out[1]!.high).toBe(102);
  });

  it('splits a multi-year series into one chunk per year', async () => {
    await putBars('AAPL', '1day', [bar('2019-06-03', 50), bar('2020-06-03', 60), bar('2021-06-03', 70)], 'schwab');
    const chunks = Array.from(table.values()).filter(i => i.sk.startsWith('CHUNK#'));
    expect(chunks.map(c => c.chunkId).sort()).toEqual(['2019', '2020', '2021']);
  });

  it('is idempotent — rewriting the same bars does not duplicate them', async () => {
    const bars = [bar('2020-01-02', 100), bar('2020-01-03', 101)];
    await putBars('AAPL', '1day', bars, 'schwab');
    await putBars('AAPL', '1day', bars, 'schwab');
    expect(await getBars('AAPL', '1day')).toHaveLength(2);
  });

  it('lets a later write correct a provisional bar in place', async () => {
    // The capture job re-reads its trailing window; the intraday snapshot of
    // today's bar must be replaced by the settled one, not stored alongside it.
    await putBars('AAPL', '1day', [bar('2020-01-02', 100)], 'schwab');
    await putBars('AAPL', '1day', [bar('2020-01-02', 105)], 'schwab');
    const out = await getBars('AAPL', '1day');
    expect(out).toHaveLength(1);
    expect(out[0]!.close).toBe(105);
  });

  it('appends into an existing chunk without dropping what was there', async () => {
    await putBars('AAPL', '1day', [bar('2020-01-02', 100)], 'schwab');
    await putBars('AAPL', '1day', [bar('2020-01-03', 101)], 'schwab');
    expect(await getBars('AAPL', '1day')).toHaveLength(2);
  });

  it('returns bars ascending even when handed them out of order', async () => {
    await putBars('AAPL', '1day', [bar('2020-03-02', 3), bar('2020-01-02', 1), bar('2020-02-02', 2)], 'schwab');
    const out = await getBars('AAPL', '1day');
    expect(out.map(b => b.close)).toEqual([1, 2, 3]);
  });

  it('refuses a chunk that would exceed the DynamoDB item ceiling', async () => {
    // 4,000 minute bars in one session id — impossible in practice (a real
    // extended-hours session stores ~1,100), but a mis-chunked interval must
    // fail loudly rather than hit DynamoDB's opaque 400 KB ValidationException.
    const many = Array.from({ length: 4000 }, (_, i) => ({
      timestamp: Date.parse('2026-08-19T13:30:00Z') + i * 1000,
      open: 1, high: 1, low: 1, close: 1, volume: 1,
    }));
    await expect(putBars('AAPL', '1min', many, 'schwab')).rejects.toThrow(/over the 3000 cap/);
  });
});

describe('coverage', () => {
  it('summarises the stored range', async () => {
    await putBars('AAPL', '1day', [bar('2019-06-03', 50), bar('2021-06-03', 70)], 'schwab');
    const coverage = await getCoverage('AAPL', '1day');
    expect(coverage?.barCount).toBe(2);
    expect(coverage?.chunkCount).toBe(2);
    expect(new Date(coverage!.firstTs).toISOString()).toContain('2019-06-03');
  });

  it('records that Schwab prices are not dividend-adjusted', async () => {
    // Carried with the data so a total-return calculation can't quietly assume
    // the wrong convention years from now.
    await putBars('KO', '1day', [bar('2010-06-01', 25.6)], 'schwab');
    expect((await getCoverage('KO', '1day'))?.adjustment).toMatch(/NOT dividend-adjusted/);
  });
});

describe('getBars range filtering', () => {
  beforeEach(async () => {
    await putBars('AAPL', '1day', [
      bar('2018-06-03', 1), bar('2019-06-03', 2), bar('2020-06-03', 3), bar('2021-06-03', 4),
    ], 'schwab');
  });

  it('trims to an inclusive date window', async () => {
    const out = await getBars('AAPL', '1day', { from: '2019-01-01', to: '2020-12-31' });
    expect(out.map(b => b.close)).toEqual([2, 3]);
  });

  it('includes bars inside the boundary chunk itself', async () => {
    // The upper bound is a chunk id, so a naive BETWEEN would exclude every bar
    // in the final chunk. `2021` must come back here.
    const out = await getBars('AAPL', '1day', { from: '2021-01-01', to: '2021-12-31' });
    expect(out.map(b => b.close)).toEqual([4]);
  });

  it('rejects an unparseable bound instead of silently returning everything', async () => {
    await expect(getBars('AAPL', '1day', { from: 'not-a-date' })).rejects.toThrow(/Unparseable/);
  });

  it('returns an empty series for a symbol that was never stored', async () => {
    expect(await getBars('ZZZZ', '1day')).toEqual([]);
  });
});

describe('daily bars deduplicate by session, not by epoch', () => {
  /**
   * The defect this guards. Schwab does not return a stable epoch for a daily
   * bar: an incremental refetch of 2026-08-19 came back at 04:00Z where the
   * original backfill had stored 05:00Z. Keyed on the raw timestamp the two did
   * not collide, so the session was stored twice — and every incremental run
   * would add another copy. A duplicated daily bar corrupts every rolling
   * window that spans it.
   */
  const bar = (iso: string, close: number) => ({
    timestamp: Date.parse(iso), open: close, high: close, low: close, close, volume: 1000,
  });

  it('collapses the same ET session arriving at a different epoch', async () => {
    await putBars('DEDUPE', '1day', [bar('2026-08-19T05:00:00Z', 20.24)], 'schwab');
    await putBars('DEDUPE', '1day', [bar('2026-08-19T04:00:00Z', 20.24)], 'schwab');
    const bars = await getBars('DEDUPE', '1day');
    expect(bars.length).toBe(1);
  });

  it('keeps the original timestamp so repeated refreshes do not shift the series', async () => {
    const original = Date.parse('2026-08-19T05:00:00Z');
    await putBars('STABLE', '1day', [bar('2026-08-19T05:00:00Z', 20.24)], 'schwab');
    await putBars('STABLE', '1day', [bar('2026-08-19T04:00:00Z', 21.00)], 'schwab');
    const bars = await getBars('STABLE', '1day');
    expect(bars.length).toBe(1);
    expect(Date.parse(bars[0].datetime)).toBe(original);
    // ...while the newer VALUES win, so a corrected close still lands.
    expect(bars[0].close).toBe(21.00);
  });

  it('repairs a chunk that already holds a duplicate', async () => {
    await putBars('REPAIR', '1day', [
      bar('2026-08-19T04:00:00Z', 20.24),
      bar('2026-08-19T05:00:00Z', 20.24),
    ], 'schwab');
    // Any later merge into the chunk collapses it — this is the repair path.
    await putBars('REPAIR', '1day', [bar('2026-08-20T05:00:00Z', 21.57)], 'schwab');
    const bars = await getBars('REPAIR', '1day');
    const dates = bars.map(b => b.datetime.slice(0, 10));
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('still keeps every intraday bar within one session', async () => {
    await putBars('INTRA', '1min', [
      bar('2026-08-19T14:30:00Z', 100),
      bar('2026-08-19T14:31:00Z', 101),
    ], 'schwab');
    expect((await getBars('INTRA', '1min')).length).toBe(2);
  });
});
