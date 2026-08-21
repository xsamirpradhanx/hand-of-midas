/**
 * Broker connection status for the calling principal.
 *
 * Exists because silent degradation is indistinguishable from working software.
 * Every Schwab-preferring request falls back to Yahoo when the grant is dead, so
 * the client fired a transient "Schwab unavailable / Sourced from Yahoo" toast on
 * each call — once every few seconds, indefinitely, with no way to act on it.
 * A persistent outage needs a persistent, actionable signal instead.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { schwabFor, currentBrokerPrincipal, type BrokerStatus } from '../services/brokers/index.js';
import { jsonResponse } from '../utils/response.js';

export async function getBrokerStatusRoute(
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const principal = currentBrokerPrincipal();

  // status() answers from stored state and never mints a token, so polling this
  // cannot itself burn a refresh grant.
  const brokers: BrokerStatus[] = [];
  try {
    brokers.push(await schwabFor().status());
  } catch (err: any) {
    brokers.push({
      broker: 'schwab',
      connected: false,
      needsReauth: true,
      reason: err?.message ?? 'Status unavailable.',
    });
  }

  return jsonResponse(200, {
    principal,
    brokers,
    // Callers use this to decide whether a fallback is worth surfacing at all.
    anyNeedsReauth: brokers.some(b => b.needsReauth),
  });
}
