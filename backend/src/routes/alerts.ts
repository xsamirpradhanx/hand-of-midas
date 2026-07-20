import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../utils/response.js';
import { queryItems, putItem, deleteItem } from '../services/dynamodb.js';
import crypto from 'crypto';

export interface AlertItem {
  pk: string;
  sk: string;
  id?: string;
  symbol: string;
  message: string;
  timestamp: string;
  severity: 'high' | 'medium';
}

function getUserId(event: APIGatewayProxyEventV2): string | null {
  return event.requestContext?.authorizer?.jwt?.claims['sub'] ?? null;
}

/** GET /api/alerts — returns global system alerts plus alerts created by this user. */
export async function getAlerts(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = getUserId(event);

    const [globalAlerts, userAlerts] = await Promise.all([
      queryItems<AlertItem>('GLOBAL_ALERTS', 'ALERT#').catch(() => [] as AlertItem[]),
      userId
        ? queryItems<AlertItem>(`USER#${userId}`, 'ALERT#').catch(() => [] as AlertItem[])
        : Promise.resolve([] as AlertItem[]),
    ]);

    const merged = [...globalAlerts, ...userAlerts];
    merged.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    return jsonResponse(200, merged.slice(0, 50));
  } catch (err: any) {
    console.error('Failed to get alerts:', err);
    return jsonResponse(500, { error: 'Failed to get alerts' });
  }
}

/** POST /api/alerts — create a user-scoped alert. */
export async function createAlert(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const userId = getUserId(event);
  if (!userId) return jsonResponse(401, { error: 'Unauthorized' });

  if (!event.body) return jsonResponse(400, { error: 'Request body is required' });

  try {
    let bodyText = event.body;
    if (event.isBase64Encoded) {
      bodyText = Buffer.from(bodyText, 'base64').toString('utf-8');
    }

    const parsed = JSON.parse(bodyText) as { symbol?: string; message?: string; severity?: string };
    if (!parsed.message) return jsonResponse(400, { error: '"message" is required' });

    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const alert: AlertItem = {
      pk: `USER#${userId}`,
      sk: `ALERT#${id}`,
      id,
      symbol: parsed.symbol ?? '',
      message: parsed.message,
      timestamp,
      severity: parsed.severity === 'high' ? 'high' : 'medium',
    };

    await putItem(alert);
    return jsonResponse(201, alert);
  } catch (err: any) {
    return jsonResponse(400, { error: err.message });
  }
}

/** DELETE /api/alerts/:id — delete a user-scoped alert. */
export async function deleteAlert(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  const userId = getUserId(event);
  if (!userId) return jsonResponse(401, { error: 'Unauthorized' });

  const id = params['id'];
  if (!id) return jsonResponse(400, { error: '"id" is required' });

  try {
    await deleteItem(`USER#${userId}`, `ALERT#${id}`);
    return jsonResponse(204, undefined);
  } catch (err: any) {
    return jsonResponse(500, { error: err.message });
  }
}
