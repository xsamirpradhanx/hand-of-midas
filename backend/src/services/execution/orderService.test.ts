import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { placeOrder, reconcileOrder, validateIntent } from './orderService.js';
import { PaperExecutor } from './paperExecutor.js';
import { OrderValidationError, TradingDisabledError, type OrderIntent, type SignalProvenance } from './types.js';

// ── in-memory DynamoDB ──────────────────────────────────────────────────────
const table = new Map<string, any>();
const k = (pk: string, sk: string) => `${pk}|${sk}`;

vi.mock('../dynamodb.js', () => ({
  getItem: async (pk: string, sk: string) => table.get(k(pk, sk)),
  putItem: async (item: any, expectedVersion?: number) => {
    const key = k(item.pk, item.sk);
    const cur = table.get(key);
    if (expectedVersion === 0 && cur) {
      const e: any = new Error('exists'); e.name = 'ConditionalCheckFailedException'; throw e;
    }
    if (expectedVersion !== undefined && expectedVersion > 0 && cur && cur.version !== expectedVersion) {
      const e: any = new Error('stale'); e.name = 'ConditionalCheckFailedException'; throw e;
    }
    table.set(key, item);
  },
  queryItems: async (pk: string, prefix: string) =>
    [...table.entries()].filter(([key]) => key.startsWith(`${pk}|${prefix}`)).map(([, v]) => v),
}));

const SIGNAL: SignalProvenance = {
  predictionPk: 'PREDICTION#AAPL', predictionSk: 'TIMESTAMP#2026-08-21',
  symbol: 'AAPL', planBias: 'LONG',
  trigger: 100, stop: 95, target: 115,
  conviction: 0.42, engineVersion: 'abc1234', decidedAt: '2026-08-21T12:00:00Z',
};
const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  symbol: 'AAPL', side: 'BUY', quantity: 10, orderType: 'MARKET', signal: SIGNAL, ...over,
});

let exec: PaperExecutor;
beforeEach(() => {
  table.clear();
  exec = new PaperExecutor(() => 100);
  delete process.env['TRADING_ENABLED'];
});
afterEach(() => { delete process.env['TRADING_ENABLED']; });

const place = (key: string, over: Partial<OrderIntent> = {}, mode: 'PAPER' | 'LIVE' = 'PAPER') =>
  placeOrder({
    principal: 'alice', intent: intent(over), idempotencyKey: key,
    requestedMode: mode, executor: exec, referencePrice: 100,
  });

describe('validateIntent', () => {
  it('refuses an order that cannot name its signal', () => {
    expect(() => validateIntent(intent({ signal: { ...SIGNAL, predictionPk: '' } })))
      .toThrow(/missing signal provenance/);
    expect(() => validateIntent(intent({ signal: { ...SIGNAL, engineVersion: '' } })))
      .toThrow(/missing engineVersion/);
  });

  it('refuses a stop on the wrong side of the trigger', () => {
    // Converts a risk control into an immediate exit — a thesis error, not a typo.
    expect(() => validateIntent(intent({ signal: { ...SIGNAL, stop: 105 } })))
      .toThrow(/not below trigger/);
    expect(() => validateIntent(intent({
      signal: { ...SIGNAL, planBias: 'SHORT', trigger: 100, stop: 95, target: 85 },
    }))).toThrow(/not above trigger/);
  });

  it('refuses incoherent quantities and missing prices', () => {
    expect(() => validateIntent(intent({ quantity: 0 }))).toThrow(/positive number/);
    expect(() => validateIntent(intent({ quantity: -5 }))).toThrow(/positive number/);
    expect(() => validateIntent(intent({ quantity: 1.5 }))).toThrow(/Fractional/);
    expect(() => validateIntent(intent({ orderType: 'LIMIT' }))).toThrow(/requires a positive limitPrice/);
    expect(() => validateIntent(intent({ orderType: 'STOP' }))).toThrow(/requires a positive stopPrice/);
  });

  it('refuses an order whose symbol disagrees with its signal', () => {
    expect(() => validateIntent(intent({ symbol: 'MSFT' }))).toThrow(/does not match/);
  });
});

describe('kill switch', () => {
  it('refuses LIVE when the server switch is unset', async () => {
    await expect(place('k1', {}, 'LIVE')).rejects.toBeInstanceOf(TradingDisabledError);
  });

  it('refuses LIVE when the server allows it but the account has not opted in', async () => {
    process.env['TRADING_ENABLED'] = 'true';
    await expect(place('k2', {}, 'LIVE')).rejects.toThrow(/has not enabled live trading/);
  });

  it('allows PAPER without any opt-in', async () => {
    const o = await place('k3');
    expect(o.mode).toBe('PAPER');
    expect(o.status).toBe('FILLED');
  });

  it('blocks even PAPER once a halt is latched', async () => {
    table.set(k('USER#alice', 'TRADING_HALT'), {
      pk: 'USER#alice', sk: 'TRADING_HALT', haltedAt: 'now', reason: 'divergence',
    });
    // Simulating against a picture we know is wrong teaches the wrong lesson.
    await expect(place('k4')).rejects.toThrow(/Halted: divergence/);
  });
});

describe('idempotency', () => {
  it('returns the original order instead of placing a second one', async () => {
    const first = await place('same-key');
    const second = await place('same-key');
    expect(second.orderId).toBe(first.orderId);
    expect(second.brokerOrderId).toBe(first.brokerOrderId);

    const orders = [...table.keys()].filter(key => key.includes('|ORDER#'));
    expect(orders).toHaveLength(1); // the whole point: no second fill
  });

  it('treats different keys as different orders', async () => {
    const a = await place('key-a');
    const b = await place('key-b');
    expect(a.orderId).not.toBe(b.orderId);
    expect([...table.keys()].filter(key => key.includes('|ORDER#'))).toHaveLength(2);
  });

  it('claims the key BEFORE submitting, so a crashed submit cannot duplicate', async () => {
    const boom = {
      broker: 'boom',
      submit: async () => { throw new Error('network died mid-flight'); },
      fetch: async () => null,
      cancel: async () => {},
    };
    await expect(placeOrder({
      principal: 'alice', intent: intent(), idempotencyKey: 'crash-key',
      requestedMode: 'PAPER', executor: boom, referencePrice: 100,
    })).rejects.toThrow(/network died/);

    // The outcome is genuinely unknown, so it must NOT be recorded as rejected.
    const stored = [...table.values()].find(v => String(v.sk).startsWith('ORDER#'));
    expect(stored.status).toBe('UNKNOWN');
    // And the claim survives, so a retry cannot place a second order.
    expect(table.get(k('USER#alice', 'IDEMPOTENCY#crash-key'))).toBeDefined();
  });
});

describe('audit trail', () => {
  it('records every transition with its cause, append-only', async () => {
    const o = await place('audit-key');
    expect(o.events.map(e => `${e.from}->${e.to}`)).toEqual([
      'DRAFT->PENDING_SUBMIT', 'PENDING_SUBMIT->FILLED',
    ]);
    expect(o.events[1].brokerRef).toContain('PAPER-');
    expect(o.signal.predictionPk).toBe('PREDICTION#AAPL');
    expect(o.signal.engineVersion).toBe('abc1234');
  });
});

describe('reconciliation', () => {
  it('takes the broker\'s status over its own', async () => {
    const o = await place('rec-1', { orderType: 'LIMIT', limitPrice: 90 });
    expect(o.status).toBe('SUBMITTED'); // resting, not marketable at mark 100

    exec.forceState(o.brokerOrderId!, 'FILLED', 10, 90);
    const r = await reconcileOrder('alice', o.orderId, exec);
    expect(r.changed).toBe(true);
    expect(r.after).toBe('FILLED');

    const stored = table.get(k('USER#alice', `ORDER#${o.orderId}`));
    expect(stored.filledQuantity).toBe(10);
    expect(stored.avgFillPrice).toBe(90);
  });

  it('halts when an order we think is working is unknown to the broker', async () => {
    const o = await place('rec-2', { orderType: 'LIMIT', limitPrice: 90 });
    exec.forget(o.brokerOrderId!);

    const r = await reconcileOrder('alice', o.orderId, exec);
    expect(r.halted).toMatch(/unknown to paper/);
    expect(table.get(k('USER#alice', 'TRADING_HALT'))).toBeDefined();
    // Trading stops until a human clears it.
    await expect(place('rec-2b')).rejects.toThrow(/Halted/);
  });

  it('halts when a terminal order moves underneath us', async () => {
    const o = await place('rec-3'); // fills immediately
    expect(o.status).toBe('FILLED');

    exec.forceState(o.brokerOrderId!, 'CANCELLED', 0);
    const r = await reconcileOrder('alice', o.orderId, exec);
    expect(r.halted).toMatch(/was FILLED locally but CANCELLED/);
  });

  it('is a no-op when both sides already agree', async () => {
    const o = await place('rec-4');
    const r = await reconcileOrder('alice', o.orderId, exec);
    expect(r.changed).toBe(false);
    expect(r.halted).toBeUndefined();
  });
});
