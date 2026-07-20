import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WebSocketEvent {
  requestContext: {
    connectionId: string;
    routeKey: '$connect' | '$disconnect' | '$default';
    domainName: string;
    stage: string;
  };
  body?: string;
}

interface WebSocketResult {
  statusCode: number;
  body?: string;
}

interface ConnectionItem {
  connectionId: string;
  subscribedSymbols: string[];
  connectedAt: string;
  ttl: number;
}

interface SubscribeMessage {
  action: 'subscribe' | 'unsubscribe';
  symbols: string[];
}

// ---------------------------------------------------------------------------
// DynamoDB client
// ---------------------------------------------------------------------------

const rawClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: { removeUndefinedValues: true, convertEmptyValues: true },
});

const CONNECTIONS_TABLE = process.env['CONNECTIONS_TABLE'] ?? 'HandOfMidasConnections';

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * $connect — store the new connection in DynamoDB with a 24-hour TTL.
 */
async function handleConnect(connectionId: string): Promise<WebSocketResult> {
  const ttl = Math.floor(Date.now() / 1000) + 86400; // 24 hours

  await docClient.send(
    new PutCommand({
      TableName: CONNECTIONS_TABLE,
      Item: {
        connectionId,
        subscribedSymbols: [],
        connectedAt: new Date().toISOString(),
        ttl,
      } satisfies ConnectionItem,
    }),
  );

  console.log(`[WebSocket] Connected: ${connectionId}`);
  return { statusCode: 200, body: 'Connected' };
}

/**
 * $disconnect — remove the connection from DynamoDB.
 */
async function handleDisconnect(connectionId: string): Promise<WebSocketResult> {
  await docClient.send(
    new DeleteCommand({
      TableName: CONNECTIONS_TABLE,
      Key: { connectionId },
    }),
  );

  console.log(`[WebSocket] Disconnected: ${connectionId}`);
  return { statusCode: 200, body: 'Disconnected' };
}

/**
 * $default — handle subscription messages.
 *
 * Clients send: `{ action: 'subscribe', symbols: ['AAPL', 'SPY'] }`
 * or           `{ action: 'unsubscribe', symbols: ['AAPL'] }`
 */
async function handleMessage(
  connectionId: string,
  body: string,
  domainName: string,
  stage: string,
): Promise<WebSocketResult> {
  let message: SubscribeMessage;

  try {
    message = JSON.parse(body) as SubscribeMessage;
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  if (message.action === 'subscribe' || message.action === 'unsubscribe') {
    // Fetch current subscriptions
    const result = await docClient.send(
      new ScanCommand({
        TableName: CONNECTIONS_TABLE,
        FilterExpression: 'connectionId = :cid',
        ExpressionAttributeValues: { ':cid': connectionId },
      }),
    );

    const existing = (result.Items?.[0] as ConnectionItem | undefined)?.subscribedSymbols ?? [];

    let updated: string[];
    if (message.action === 'subscribe') {
      updated = Array.from(new Set([...existing, ...message.symbols.map(s => s.toUpperCase())]));
    } else {
      const toRemove = new Set(message.symbols.map(s => s.toUpperCase()));
      updated = existing.filter(s => !toRemove.has(s));
    }

    const ttl = Math.floor(Date.now() / 1000) + 86400;
    await docClient.send(
      new PutCommand({
        TableName: CONNECTIONS_TABLE,
        Item: {
          connectionId,
          subscribedSymbols: updated,
          connectedAt: new Date().toISOString(),
          ttl,
        },
      }),
    );

    // Acknowledge back to the client
    const endpoint = `https://${domainName}/${stage}`;
    const apigw = new ApiGatewayManagementApiClient({ endpoint });

    try {
      await apigw.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: Buffer.from(
            JSON.stringify({ type: 'subscribed', symbols: updated }),
          ),
        }),
      );
    } catch (err) {
      // Client may have already disconnected; non-fatal
      console.warn(`[WebSocket] Failed to ack subscription to ${connectionId}:`, err);
    }
  }

  return { statusCode: 200, body: 'OK' };
}

/**
 * Fan-out a payload to all WebSocket connections subscribed to a given symbol.
 * Called by the chainRefresh Lambda after processing options data.
 */
export async function broadcastToSubscribers(
  symbol: string,
  payload: unknown,
  endpoint: string,
): Promise<void> {
  // Scan for connections subscribed to this symbol
  const result = await docClient.send(
    new ScanCommand({
      TableName: CONNECTIONS_TABLE,
      FilterExpression: 'contains(subscribedSymbols, :sym)',
      ExpressionAttributeValues: { ':sym': symbol.toUpperCase() },
    }),
  );

  const connections = (result.Items ?? []) as ConnectionItem[];
  if (connections.length === 0) return;

  const apigw = new ApiGatewayManagementApiClient({ endpoint });
  const data = Buffer.from(JSON.stringify({ type: 'update', symbol, data: payload }));

  await Promise.allSettled(
    connections.map(conn =>
      apigw
        .send(new PostToConnectionCommand({ ConnectionId: conn.connectionId, Data: data }))
        .catch(err => {
          // 410 = stale connection, clean up
          if ((err as any).statusCode === 410) {
            return docClient.send(
              new DeleteCommand({ TableName: CONNECTIONS_TABLE, Key: { connectionId: conn.connectionId } }),
            );
          }
        }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Lambda handler
// ---------------------------------------------------------------------------

export async function handler(event: WebSocketEvent): Promise<WebSocketResult> {
  const { connectionId, routeKey, domainName, stage } = event.requestContext;

  try {
    switch (routeKey) {
      case '$connect':
        return await handleConnect(connectionId);

      case '$disconnect':
        return await handleDisconnect(connectionId);

      case '$default':
        return await handleMessage(connectionId, event.body ?? '{}', domainName, stage);

      default:
        return { statusCode: 400, body: 'Unknown route' };
    }
  } catch (err) {
    console.error('[WebSocket] Error:', err);
    return { statusCode: 500, body: 'Internal error' };
  }
}
