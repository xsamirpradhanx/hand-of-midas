/**
 * Order lifecycle: validate, gate, claim, submit, reconcile.
 *
 * There is deliberately NO live broker adapter wired in here. Submission goes
 * through a `BrokerExecutor` the caller supplies, and the only implementation in
 * the repo is the paper one. Adding a real venue is then a single, reviewable,
 * obviously-consequential change rather than something that arrives as a side
 * effect of a refactor.
 */
import { randomUUID } from 'node:crypto';
import { assertTradingAllowed, haltTrading } from './killSwitch.js';
import { claimIdempotencyKey, findByIdempotencyKey, getOrder, saveOrder } from './orderStore.js';
import {
  OrderValidationError, isTerminal,
  type ExecutionMode, type OrderEvent, type OrderIntent, type OrderStatus, type StoredOrder,
} from './types.js';

/** What a venue adapter must provide. Paper and live implement the same shape. */
export interface BrokerExecutor {
  readonly broker: string;
  /**
   * Submit and return everything the acknowledgement carries.
   *
   * `filledQuantity` is part of the ack, not an afterthought: a marketable order
   * can come back already filled, and recording the status without the quantity
   * leaves the local position at zero until reconciliation happens to run. Any
   * sizing decision taken in between would be made against a wrong position.
   */
  submit(order: StoredOrder): Promise<{
    brokerOrderId: string;
    status: OrderStatus;
    filledQuantity?: number;
    avgFillPrice?: number;
  }>;
  /** Fetch the broker's own view. This is the source of truth, not our record. */
  fetch(order: StoredOrder): Promise<{
    status: OrderStatus; filledQuantity: number; avgFillPrice?: number; raw?: string;
  } | null>;
  cancel(order: StoredOrder): Promise<void>;
}

function event(from: OrderStatus, to: OrderStatus, reason: string, brokerRef?: string): OrderEvent {
  return { at: new Date().toISOString(), from, to, reason, brokerRef };
}

/**
 * Reject anything structurally incoherent before it can reach a venue.
 *
 * These are not stylistic checks. A negative quantity, a limit order with no
 * limit, or a stop on the wrong side of the trigger are all things that either
 * get rejected at the venue or — worse — get accepted and do something the
 * operator did not intend.
 */
export function validateIntent(intent: OrderIntent): void {
  const { quantity, orderType, limitPrice, stopPrice, signal } = intent;

  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new OrderValidationError(`Quantity must be a positive number, got ${quantity}.`);
  }
  if (!Number.isInteger(quantity)) {
    throw new OrderValidationError(`Fractional quantity ${quantity} is not supported.`);
  }
  if ((orderType === 'LIMIT' || orderType === 'STOP_LIMIT') && !(limitPrice! > 0)) {
    throw new OrderValidationError(`${orderType} requires a positive limitPrice.`);
  }
  if ((orderType === 'STOP' || orderType === 'STOP_LIMIT') && !(stopPrice! > 0)) {
    throw new OrderValidationError(`${orderType} requires a positive stopPrice.`);
  }
  // Provenance is mandatory: an order that cannot name its signal cannot be
  // reviewed afterwards and should not reach a venue.
  if (!signal?.predictionPk || !signal?.predictionSk) {
    throw new OrderValidationError('Order is missing signal provenance; refusing to submit.');
  }
  if (!signal.engineVersion) {
    throw new OrderValidationError('Order is missing engineVersion; refusing to submit.');
  }
  if (signal.symbol !== intent.symbol) {
    throw new OrderValidationError(
      `Order symbol ${intent.symbol} does not match its signal's symbol ${signal.symbol}.`,
    );
  }
  // A stop on the wrong side of the trigger is a thesis error, not a typo, and
  // it converts a risk control into an immediate exit.
  const long = signal.planBias === 'LONG';
  if (long && signal.stop >= signal.trigger) {
    throw new OrderValidationError(`LONG stop ${signal.stop} is not below trigger ${signal.trigger}.`);
  }
  if (!long && signal.stop <= signal.trigger) {
    throw new OrderValidationError(`SHORT stop ${signal.stop} is not above trigger ${signal.trigger}.`);
  }
}

export interface PlaceOptions {
  readonly principal: string;
  readonly intent: OrderIntent;
  /** Unique per intent. Reusing one returns the original order, never a new fill. */
  readonly idempotencyKey: string;
  readonly requestedMode: ExecutionMode;
  readonly executor: BrokerExecutor;
  /** Reference price used only for the notional cap. */
  readonly referencePrice: number;
}

/**
 * Place an order, or return the existing one for this idempotency key.
 *
 * Ordering matters and is not negotiable: validate, then gate, then CLAIM, then
 * submit. Claiming before submitting is what makes a retry safe — a crash
 * between claim and submit leaves a PENDING_SUBMIT record that reconciliation
 * can resolve against the broker, whereas a crash between submit and claim would
 * leave a live order nothing knows about.
 */
export async function placeOrder(opts: PlaceOptions): Promise<StoredOrder> {
  const { principal, intent, idempotencyKey, requestedMode, executor, referencePrice } = opts;

  validateIntent(intent);
  const mode = await assertTradingAllowed(principal, requestedMode, intent.quantity * referencePrice);

  const orderId = randomUUID();
  const winner = await claimIdempotencyKey(principal, idempotencyKey, orderId);
  if (winner !== orderId) {
    const existing = await findByIdempotencyKey(principal, idempotencyKey);
    if (existing) return existing; // someone already placed this exact intent
    throw new OrderValidationError(
      `Idempotency key ${idempotencyKey} is claimed by order ${winner}, which cannot be read.`,
    );
  }

  const now = new Date().toISOString();
  let order: StoredOrder = {
    ...intent,
    orderId, idempotencyKey, principal,
    broker: executor.broker, mode,
    status: 'PENDING_SUBMIT',
    filledQuantity: 0,
    createdAt: now,
    events: [event('DRAFT', 'PENDING_SUBMIT', `Claimed key ${idempotencyKey}`)],
    version: 0,
  };
  order = await saveOrder(order, 0);

  try {
    const ack = await executor.submit(order);
    order = await saveOrder({
      ...order,
      status: ack.status,
      brokerOrderId: ack.brokerOrderId,
      filledQuantity: ack.filledQuantity ?? order.filledQuantity,
      avgFillPrice: ack.avgFillPrice ?? order.avgFillPrice,
      events: [...order.events, event('PENDING_SUBMIT', ack.status, 'Broker acknowledged', ack.brokerOrderId)],
    }, order.version);
    return order;
  } catch (err) {
    // The submission may or may not have reached the venue. Recording REJECTED
    // here would be a guess, and a wrong guess invites a duplicate on retry —
    // so the order is parked in UNKNOWN for reconciliation to settle against the
    // broker's own record.
    const message = err instanceof Error ? err.message : String(err);
    order = await saveOrder({
      ...order,
      status: 'UNKNOWN',
      events: [...order.events, event('PENDING_SUBMIT', 'UNKNOWN', `Submit failed: ${message}`)],
    }, order.version);
    if (mode === 'LIVE') {
      await haltTrading(principal, `Order ${orderId} outcome unknown after submit failure`);
    }
    throw err;
  }
}

export interface ReconcileResult {
  readonly orderId: string;
  readonly before: OrderStatus;
  readonly after: OrderStatus;
  readonly changed: boolean;
  readonly halted?: string;
}

/**
 * Reconcile one order against the broker's record.
 *
 * The broker always wins. Local status is a cache; if the two disagree the local
 * one is wrong by definition, and trying to reason about which is "more recent"
 * is how systems talk themselves into ignoring a fill.
 */
export async function reconcileOrder(
  principal: string, orderId: string, executor: BrokerExecutor,
): Promise<ReconcileResult> {
  const order = await getOrder(principal, orderId);
  if (!order) throw new OrderValidationError(`Order ${orderId} not found for ${principal}.`);
  const before = order.status;

  const remote = await executor.fetch(order);

  if (!remote) {
    // The broker has no record. For an order we believe is working, that is an
    // unexplained divergence rather than a tidy "it did not exist" — halt and
    // let a human look, because the alternative is trading blind.
    if (!isTerminal(before) && before !== 'DRAFT') {
      const reason = `Order ${orderId} is ${before} locally but unknown to ${executor.broker}`;
      await haltTrading(principal, reason);
      return { orderId, before, after: before, changed: false, halted: reason };
    }
    return { orderId, before, after: before, changed: false };
  }

  if (remote.status === before && remote.filledQuantity === order.filledQuantity) {
    await saveOrder({ ...order, lastReconciledAt: new Date().toISOString() }, order.version);
    return { orderId, before, after: before, changed: false };
  }

  // A terminal order that moved is a serious divergence: it means we recorded an
  // ending the venue disagrees with.
  let halted: string | undefined;
  if (isTerminal(before) && remote.status !== before) {
    halted = `Order ${orderId} was ${before} locally but ${remote.status} at ${executor.broker}`;
    await haltTrading(principal, halted);
  }

  await saveOrder({
    ...order,
    status: remote.status,
    filledQuantity: remote.filledQuantity,
    avgFillPrice: remote.avgFillPrice ?? order.avgFillPrice,
    lastReconciledAt: new Date().toISOString(),
    events: [...order.events, event(before, remote.status, 'Reconciled against broker', remote.raw)],
  }, order.version);

  return { orderId, before, after: remote.status, changed: true, halted };
}
