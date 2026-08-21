/**
 * Browser OAuth flow for connecting a brokerage account.
 *
 * The subtlety that shapes this file: the callback arrives as a REDIRECT FROM
 * SCHWAB, so it carries no Cognito JWT and the API-Gateway authorizer cannot
 * identify the caller. The user is recovered from a `state` nonce minted at the
 * start of the flow and stored against their principal — which is also the CSRF
 * defence, since an attacker cannot forge a state we issued.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../utils/response.js';
import { getItem, putItem, deleteItem } from '../services/dynamodb.js';
import { schwabFor, currentBrokerPrincipal } from '../services/brokers/index.js';

/** Short-lived: an authorization the user abandons should not stay usable. */
const STATE_TTL_MS = 10 * 60 * 1000;

interface StateItem {
  pk: string;
  sk: string;
  principal: string;
  createdAt: string;
  expiresAt: number;
}

const stateKey = (state: string) => ({ pk: `OAUTH_STATE#${state}`, sk: 'STATE' });

/** GET /api/broker/schwab/connect — start the flow. */
export async function startSchwabConnect(
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const principal = currentBrokerPrincipal();
  const conn = schwabFor(principal);

  const state = `${randomToken()}.${Date.now().toString(36)}`;
  const { pk, sk } = stateKey(state);
  await putItem<StateItem>({
    pk, sk, principal,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + STATE_TTL_MS,
  });

  return jsonResponse(200, { authorizeUrl: conn.authorizeUrl(state), state, expiresInMs: STATE_TTL_MS });
}

/** GET /api/broker/schwab/callback?code=…&state=… — finish the flow. */
export async function schwabCallback(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const q = event.queryStringParameters ?? {};
  const code = q['code'];
  const state = q['state'];

  if (!code || !state) {
    return htmlResult(400, 'Missing authorization code', 'Schwab did not return a code. Start the connection again.');
  }

  const { pk, sk } = stateKey(state);
  const stored = await getItem<StateItem>(pk, sk);
  // Single-use: consumed whether or not the exchange succeeds, so a leaked
  // callback URL cannot be replayed.
  if (stored) await deleteItem(pk, sk);

  if (!stored) {
    return htmlResult(400, 'Unrecognised request', 'This authorization link was not issued by us, or it has already been used.');
  }
  if (stored.expiresAt < Date.now()) {
    return htmlResult(400, 'Link expired', 'The authorization window closed. Start the connection again.');
  }

  try {
    await schwabFor(stored.principal).completeAuthorization(decodeURIComponent(code));
  } catch (err: any) {
    return htmlResult(502, 'Could not complete the connection', err?.message ?? 'The token exchange failed.');
  }

  return htmlResult(200, 'Schwab connected', 'You can close this tab and return to Hand of Midas.');
}

function randomToken(): string {
  // Node 20+ exposes webcrypto globally; 32 hex chars is ample for a CSRF nonce.
  const bytes = new Uint8Array(16);
  (globalThis.crypto as Crypto).getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The callback renders in a browser tab, so it answers in HTML, not JSON. */
function htmlResult(status: number, title: string, detail: string): APIGatewayProxyResultV2 {
  const ok = status === 200;
  return {
    statusCode: status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<div style="font-family:system-ui;background:#0a0e27;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
  <div style="max-width:420px;text-align:center">
    <div style="font-size:2rem;margin-bottom:12px">${ok ? '✅' : '⚠️'}</div>
    <h1 style="font-size:1.2rem;color:${ok ? '#f5c842' : '#ff8a65'};margin:0 0 8px">${title}</h1>
    <p style="font-size:.95rem;line-height:1.5;margin:0;color:#9e9eb8">${detail}</p>
  </div>
</div>`,
  };
}
