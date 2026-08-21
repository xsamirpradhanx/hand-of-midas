/**
 * Simulated venue. The only executor in the repo.
 *
 * Everything runs against this until a live adapter is deliberately added, which
 * keeps "can this system send a real order?" answerable by grep rather than by
 * reading a call graph.
 *
 * Fills are intentionally naive — marketable orders fill immediately at the
 * reference price, resting orders stay working. There is no slippage model, no
 * partial-fill model and no queue position, so paper results are an OPTIMISTIC
 * bound and must never be quoted as expected live performance.
 */
import { randomUUID } from 'node:crypto';
import type { BrokerExecutor } from './orderService.js';
import type { OrderStatus, StoredOrder } from './types.js';

export class PaperExecutor implements BrokerExecutor {
  readonly broker = 'paper';
  private readonly book = new Map<string, { status: OrderStatus; filled: number; avg?: number }>();

  constructor(private readonly markPrice: (symbol: string) => number) {}

  async submit(order: StoredOrder): Promise<{
    brokerOrderId: string; status: OrderStatus; filledQuantity?: number; avgFillPrice?: number;
  }> {
    const brokerOrderId = `PAPER-${randomUUID()}`;
    const mark = this.markPrice(order.symbol);

    const marketable =
      order.orderType === 'MARKET' ||
      (order.orderType === 'LIMIT' &&
        (order.side === 'BUY' || order.side === 'BUY_TO_COVER'
          ? mark <= (order.limitPrice ?? Infinity)
          : mark >= (order.limitPrice ?? 0)));

    const state = marketable
      ? { status: 'FILLED' as OrderStatus, filled: order.quantity, avg: mark }
      : { status: 'SUBMITTED' as OrderStatus, filled: 0 };

    this.book.set(brokerOrderId, state);
    return {
      brokerOrderId, status: state.status,
      filledQuantity: state.filled, avgFillPrice: state.avg,
    };
  }

  async fetch(order: StoredOrder) {
    if (!order.brokerOrderId) return null;
    const s = this.book.get(order.brokerOrderId);
    if (!s) return null;
    return { status: s.status, filledQuantity: s.filled, avgFillPrice: s.avg, raw: 'paper' };
  }

  async cancel(order: StoredOrder): Promise<void> {
    if (!order.brokerOrderId) return;
    const s = this.book.get(order.brokerOrderId);
    if (s && s.status !== 'FILLED') this.book.set(order.brokerOrderId, { ...s, status: 'CANCELLED' });
  }

  /** Test seam: force a broker-side state the local record does not know about. */
  forceState(brokerOrderId: string, status: OrderStatus, filled = 0, avg?: number): void {
    this.book.set(brokerOrderId, { status, filled, avg });
  }

  /** Test seam: make the venue forget an order, simulating a divergence. */
  forget(brokerOrderId: string): void {
    this.book.delete(brokerOrderId);
  }
}
