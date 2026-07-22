import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

interface WebSocketEvent {
  requestContext: { connectionId: string; routeKey: string };
  body?: string;
}

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const tableName = process.env['CONNECTIONS_TABLE'];

/** Persist only validated subscriptions; authentication must be enforced at API Gateway. */
export async function handler(event: WebSocketEvent): Promise<{ statusCode: number; body?: string }> {
  if (!tableName) throw new Error('CONNECTIONS_TABLE is not configured');
  const connectionId = event.requestContext.connectionId;

  if (event.requestContext.routeKey === '$connect') {
    await client.send(new PutCommand({
      TableName: tableName,
      Item: { connectionId, symbols: [], ttl: Math.floor(Date.now() / 1000) + 86_400 },
      ConditionExpression: 'attribute_not_exists(connectionId)',
    }));
    return { statusCode: 200 };
  }

  if (event.requestContext.routeKey === '$disconnect') {
    await client.send(new DeleteCommand({ TableName: tableName, Key: { connectionId } }));
    return { statusCode: 200 };
  }

  try {
    const message = JSON.parse(event.body ?? '{}') as { action?: string; symbols?: unknown };
    if (message.action !== 'subscribe' || !Array.isArray(message.symbols)) {
      return { statusCode: 400, body: 'Expected { action: "subscribe", symbols: string[] }' };
    }
    const symbols = [...new Set(message.symbols
      .filter((symbol): symbol is string => typeof symbol === 'string' && /^[A-Za-z.\-]{1,16}$/.test(symbol))
      .map(symbol => symbol.toUpperCase()))].slice(0, 100);
    await client.send(new UpdateCommand({
      TableName: tableName,
      Key: { connectionId },
      UpdateExpression: 'SET symbols = :symbols, ttl = :ttl',
      ExpressionAttributeValues: { ':symbols': symbols, ':ttl': Math.floor(Date.now() / 1000) + 86_400 },
      ConditionExpression: 'attribute_exists(connectionId)',
    }));
    return { statusCode: 200 };
  } catch {
    return { statusCode: 400, body: 'Invalid subscription message' };
  }
}
