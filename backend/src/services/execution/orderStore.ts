/**
 * Order persistence and idempotency.
 *
 * Two access paths into the same single table:
 *   pk USER#<principal>  sk ORDER#<orderId>        — the order itself
 *   pk USER#<principal>  sk IDEMPOTENCY#<key>      — the claim on a key
 *
 * The claim is written FIRST and conditionally. Whoever wins the conditional
 * write owns the submission; everyone else reads the winner's order and returns
 * it. That ordering is the point: claiming after submitting would leave a window
 * where a retry submits a second live order.
 */
import { getItem, putItem, queryItems } from '../dynamodb.js';
import { DuplicateOrderError, type StoredOrder } from './types.js';

const userPk = (principal: string) => `USER#${principal}`;
const orderSk = (orderId: string) => `ORDER#${orderId}`;
const claimSk = (key: string) => `IDEMPOTENCY#${key}`;

interface ClaimItem { pk: string; sk: string; orderId: string; claimedAt: string }

function isConditionalFailure(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException';
}

/**
 * Claim an idempotency key for `orderId`.
 *
 * Returns the winning orderId — ours if we won, the incumbent's if we lost.
 * Callers MUST compare and stand down when it is not theirs.
 */
export async function claimIdempotencyKey(
  principal: string, key: string, orderId: string,
): Promise<string> {
  try {
    await putItem<ClaimItem>(
      { pk: userPk(principal), sk: claimSk(key), orderId, claimedAt: new Date().toISOString() },
      0, // assert the claim does not exist yet
    );
    return orderId;
  } catch (err) {
    if (!isConditionalFailure(err)) throw err;
    const existing = await getItem<ClaimItem>(userPk(principal), claimSk(key));
    if (!existing) throw err; // lost the race then the winner vanished — surface it
    return existing.orderId;
  }
}

export async function getOrder(principal: string, orderId: string): Promise<StoredOrder | undefined> {
  return getItem<StoredOrder & { pk: string; sk: string }>(userPk(principal), orderSk(orderId));
}

export async function findByIdempotencyKey(
  principal: string, key: string,
): Promise<StoredOrder | undefined> {
  const claim = await getItem<ClaimItem>(userPk(principal), claimSk(key));
  return claim ? getOrder(principal, claim.orderId) : undefined;
}

/**
 * Persist an order with optimistic locking on `version`.
 *
 * A lost race means someone else advanced this order — typically reconciliation
 * writing a broker-sourced status while a local transition was in flight. The
 * caller must re-read rather than clobber: broker state outranks local intent.
 */
export async function saveOrder(order: StoredOrder, expectedVersion?: number): Promise<StoredOrder> {
  const next = { ...order, version: (expectedVersion ?? order.version) + 1 };
  try {
    await putItem({ ...next, pk: userPk(order.principal), sk: orderSk(order.orderId) } as any, expectedVersion);
  } catch (err) {
    if (isConditionalFailure(err)) throw new DuplicateOrderError(order);
    throw err;
  }
  return next;
}

export async function listOrders(principal: string): Promise<StoredOrder[]> {
  return queryItems<StoredOrder & { pk: string; sk: string }>(userPk(principal), 'ORDER#');
}
