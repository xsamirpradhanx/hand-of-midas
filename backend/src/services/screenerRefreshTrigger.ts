import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { ScreenerMode } from './screenerService.js';

const lambdaClient = new LambdaClient({});
const REFRESH_FUNCTION_NAME = process.env.SCREENER_REFRESH_FUNCTION_NAME;
const DIAGONAL_REFRESH_FUNCTION_NAME = process.env.DIAGONAL_REFRESH_FUNCTION_NAME;
const VALUE_REFRESH_FUNCTION_NAME = process.env.VALUE_REFRESH_FUNCTION_NAME;
const GROWTH_REFRESH_FUNCTION_NAME = process.env.GROWTH_REFRESH_FUNCTION_NAME;
const ETF_REFRESH_FUNCTION_NAME = process.env.ETF_REFRESH_FUNCTION_NAME;

/**
 * Kicks off a screener recompute for one mode without blocking the caller. A
 * full scan takes 3+ minutes — far past the API Lambda's 29s timeout — so
 * this can never run inline; it has to hand off and return immediately.
 *
 * In production, ScreenerRefreshFunction is a separate 300s-timeout Lambda
 * (see handofmidas-stack.ts); this fires an async ('Event') invoke and does
 * not wait for it to finish. There's no separate Lambda locally, so this
 * runs the same handler in-process instead, deliberately not awaited — same
 * fire-and-forget semantics, just without the extra hop.
 */
export async function triggerScreenerRefresh(mode: ScreenerMode): Promise<void> {
  if (REFRESH_FUNCTION_NAME) {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: REFRESH_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ mode })),
    }));
    return;
  }

  const { handler } = await import('../handlers/screenerRefresh.js');
  void handler({ mode }).catch(err => {
    console.error(`[ScreenerRefreshTrigger] Local background refresh failed for mode=${mode}:`, err);
  });
}

/** Same fire-and-forget hand-off as triggerScreenerRefresh, for the diagonal-spread scan. */
export async function triggerDiagonalRefresh(): Promise<void> {
  if (DIAGONAL_REFRESH_FUNCTION_NAME) {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: DIAGONAL_REFRESH_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({})),
    }));
    return;
  }

  const { handler } = await import('../handlers/diagonalRefresh.js');
  void handler().catch(err => {
    console.error('[ScreenerRefreshTrigger] Local background diagonal refresh failed:', err);
  });
}

/** Same fire-and-forget hand-off as triggerScreenerRefresh, for the value scan. */
export async function triggerValueRefresh(): Promise<void> {
  if (VALUE_REFRESH_FUNCTION_NAME) {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: VALUE_REFRESH_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({})),
    }));
    return;
  }

  const { handler } = await import('../handlers/valueRefresh.js');
  void handler().catch(err => {
    console.error('[ScreenerRefreshTrigger] Local background value refresh failed:', err);
  });
}

/** Same fire-and-forget hand-off as triggerScreenerRefresh, for the growth scan. */
export async function triggerGrowthRefresh(): Promise<void> {
  if (GROWTH_REFRESH_FUNCTION_NAME) {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: GROWTH_REFRESH_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({})),
    }));
    return;
  }

  const { handler } = await import('../handlers/growthRefresh.js');
  void handler().catch(err => {
    console.error('[ScreenerRefreshTrigger] Local background growth refresh failed:', err);
  });
}

/** Same fire-and-forget hand-off as triggerScreenerRefresh, for the ETF scan. */
export async function triggerEtfRefresh(): Promise<void> {
  if (ETF_REFRESH_FUNCTION_NAME) {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: ETF_REFRESH_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({})),
    }));
    return;
  }

  const { handler } = await import('../handlers/etfRefresh.js');
  void handler().catch(err => {
    console.error('[ScreenerRefreshTrigger] Local background ETF refresh failed:', err);
  });
}
