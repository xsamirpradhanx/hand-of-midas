/**
 * Order execution primitives.
 *
 * Reading positions is a feature; placing orders is regulated infrastructure
 * that moves real money. The model here is built around four rules, and every
 * one of them is enforced in code rather than left to a caller's discipline:
 *
 *   1. Nothing executes unless explicitly enabled. Default is off, and PAPER.
 *   2. Every order names the signal that produced it. An order with no traceable
 *      cause cannot be submitted.
 *   3. Every submission carries an idempotency key, so a retry, a Lambda replay
 *      or a double-click cannot produce a second fill.
 *   4. The broker is the source of truth. Local status is a cache that must be
 *      reconciled, never a record of what is actually working at the venue.
 */

export type ExecutionMode = 'PAPER' | 'LIVE';
export type OrderSide = 'BUY' | 'SELL' | 'BUY_TO_COVER' | 'SELL_SHORT';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';

/**
 * Lifecycle. Deliberately includes states for "we do not know", because the
 * dangerous case is not a rejected order — it is an order whose fate is unknown
 * while the code assumes it failed and retries.
 */
export type OrderStatus =
  | 'DRAFT'          // constructed and validated, nothing sent
  | 'PENDING_SUBMIT' // idempotency key claimed, about to hit the broker
  | 'SUBMITTED'      // broker acknowledged, working
  | 'PARTIAL'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'UNKNOWN';       // submission outcome indeterminate — needs reconciliation

/** Statuses the broker will not move away from on its own. */
export const TERMINAL_STATUSES: readonly OrderStatus[] = ['FILLED', 'CANCELLED', 'REJECTED'];

export function isTerminal(s: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

/**
 * What caused this order to exist.
 *
 * Required, not optional. The whole premise of the product is that a signal
 * justified a trade; an order that cannot name its signal cannot be reviewed
 * afterwards, cannot be graded, and should not reach a venue.
 */
export interface SignalProvenance {
  /** DynamoDB keys of the prediction this order was raised from. */
  readonly predictionPk: string;
  readonly predictionSk: string;
  readonly symbol: string;
  readonly planBias: 'LONG' | 'SHORT';
  readonly trigger: number;
  readonly stop: number;
  readonly target: number;
  /** Conviction at the moment of the decision — NOT a probability. */
  readonly conviction: number;
  /** Git SHA or build id of the engine that produced the plan. */
  readonly engineVersion: string;
  readonly decidedAt: string;
}

/** One immutable transition. Orders are append-only; nothing is overwritten. */
export interface OrderEvent {
  readonly at: string;
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  readonly reason: string;
  /** Raw broker payload, retained verbatim for dispute resolution. */
  readonly brokerRef?: string;
}

export interface OrderIntent {
  readonly symbol: string;
  readonly side: OrderSide;
  readonly quantity: number;
  readonly orderType: OrderType;
  readonly limitPrice?: number;
  readonly stopPrice?: number;
  readonly signal: SignalProvenance;
}

export interface StoredOrder extends OrderIntent {
  readonly orderId: string;
  /**
   * Caller-supplied, unique per intent. Two submissions with the same key are
   * the same order — the second returns the first's result rather than placing
   * another. This is the only thing standing between a network retry and a
   * double fill.
   */
  readonly idempotencyKey: string;
  readonly principal: string;
  readonly broker: string;
  readonly mode: ExecutionMode;
  readonly status: OrderStatus;
  readonly brokerOrderId?: string;
  readonly filledQuantity: number;
  readonly avgFillPrice?: number;
  readonly createdAt: string;
  readonly lastReconciledAt?: string;
  readonly events: readonly OrderEvent[];
  readonly version: number;
}

export class TradingDisabledError extends Error {
  constructor(reason: string) {
    super(`Trading is disabled: ${reason}`);
    this.name = 'TradingDisabledError';
  }
}

export class DuplicateOrderError extends Error {
  constructor(readonly existing: StoredOrder) {
    super(`Idempotency key ${existing.idempotencyKey} already used by order ${existing.orderId}`);
    this.name = 'DuplicateOrderError';
  }
}

export class OrderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderValidationError';
  }
}
