/**
 * The gate every order passes through.
 *
 * Four independent conditions must ALL hold before a live order can be sent, and
 * each defaults to the safe answer. They are separate on purpose: a single
 * boolean is one accidental `true` away from a live fill, and the failure mode
 * is money rather than a stack trace.
 *
 *   1. TRADING_ENABLED must be explicitly "true" in the environment.
 *   2. The principal must have opted in, stored per user.
 *   3. LIVE mode must be requested explicitly; PAPER is the default everywhere.
 *   4. No halt may be latched.
 *
 * A halt is deliberately sticky. It is tripped by reconciliation finding
 * something it cannot explain — an order the broker knows about that we do not,
 * a fill we never recorded — and it stays tripped until a human clears it. The
 * whole point is to stop trading when the system's picture of reality has
 * diverged from the venue's, which is exactly when continuing is most dangerous.
 */
import { getItem, putItem } from '../dynamodb.js';
import { TradingDisabledError, type ExecutionMode } from './types.js';

const HALT_SK = 'TRADING_HALT';
const OPTIN_SK = 'TRADING_OPTIN';

interface HaltItem {
  pk: string;
  sk: string;
  haltedAt: string;
  reason: string;
  clearedAt?: string;
}

interface OptInItem {
  pk: string;
  sk: string;
  enabled: boolean;
  mode: ExecutionMode;
  /** Refuse any single order larger than this notional, per principal. */
  maxNotionalPerOrder: number;
  updatedAt: string;
}

const userPk = (principal: string) => `USER#${principal}`;

/** Global switch. Absent or anything other than "true" means disabled. */
export function tradingEnabledGlobally(): boolean {
  return process.env['TRADING_ENABLED'] === 'true';
}

export async function getHalt(principal: string): Promise<HaltItem | undefined> {
  const item = await getItem<HaltItem>(userPk(principal), HALT_SK);
  return item && !item.clearedAt ? item : undefined;
}

/** Trip the halt. Safe to call repeatedly; the first reason is preserved. */
export async function haltTrading(principal: string, reason: string): Promise<void> {
  const existing = await getHalt(principal);
  if (existing) return;
  await putItem<HaltItem>({
    pk: userPk(principal), sk: HALT_SK,
    haltedAt: new Date().toISOString(), reason,
  });
}

/** Clear a halt. Intentionally NOT called from any automated path. */
export async function clearHalt(principal: string, clearedBy: string): Promise<void> {
  const existing = await getItem<HaltItem>(userPk(principal), HALT_SK);
  if (!existing) return;
  await putItem<HaltItem>({
    ...existing,
    clearedAt: new Date().toISOString(),
    reason: `${existing.reason} | cleared by ${clearedBy}`,
  });
}

export async function getOptIn(principal: string): Promise<OptInItem | undefined> {
  return getItem<OptInItem>(userPk(principal), OPTIN_SK);
}

export interface GateDecision {
  readonly allowed: boolean;
  readonly mode: ExecutionMode;
  readonly reason?: string;
}

/**
 * Decide whether `principal` may place an order of `notional` in `requestedMode`.
 *
 * Never throws for a plain "not allowed" — callers need to render the reason.
 * Use assertTradingAllowed when a refusal should abort.
 */
export async function checkTradingGate(
  principal: string,
  requestedMode: ExecutionMode,
  notional: number,
): Promise<GateDecision> {
  // PAPER never reaches a venue, so it bypasses the global switch and the opt-in
  // — but NOT the halt. When our picture of reality has diverged, simulating
  // against that broken picture teaches the wrong lesson.
  const halt = await getHalt(principal);
  if (halt) {
    return { allowed: false, mode: requestedMode, reason: `Halted: ${halt.reason}` };
  }
  if (requestedMode === 'PAPER') return { allowed: true, mode: 'PAPER' };

  if (!tradingEnabledGlobally()) {
    return { allowed: false, mode: 'PAPER', reason: 'TRADING_ENABLED is not set on the server.' };
  }
  const optIn = await getOptIn(principal);
  if (!optIn?.enabled) {
    return { allowed: false, mode: 'PAPER', reason: 'This account has not enabled live trading.' };
  }
  if (optIn.mode !== 'LIVE') {
    return { allowed: false, mode: optIn.mode, reason: `Account is configured for ${optIn.mode}.` };
  }
  if (notional > optIn.maxNotionalPerOrder) {
    return {
      allowed: false, mode: 'PAPER',
      reason: `Order notional ${notional.toFixed(2)} exceeds the per-order limit of ${optIn.maxNotionalPerOrder.toFixed(2)}.`,
    };
  }
  return { allowed: true, mode: 'LIVE' };
}

export async function assertTradingAllowed(
  principal: string,
  requestedMode: ExecutionMode,
  notional: number,
): Promise<ExecutionMode> {
  const d = await checkTradingGate(principal, requestedMode, notional);
  if (!d.allowed) throw new TradingDisabledError(d.reason ?? 'not allowed');
  return d.mode;
}
